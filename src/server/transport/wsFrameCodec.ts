/**
 * RFC6455 帧编解码（Wave D ④ 传输栈评估的审计与拆分产物）。
 *
 * ## 为什么单独成文件
 *
 * 2026-10-04 的传输栈评估审计出帧层 4 处协议一致性缺陷（分片被当完整消息、无 ping/pong、
 * 无 UTF-8 校验、未校验掩码位），修复后 `WsConnection` 越过了上帝类红线（542 行 / 31 方法）——
 * 于是按职责拆出本类：**「字节 ↔ 帧」是纯编解码**（无状态、可单独推理与复用），
 * 而「连接生命周期 / 背压 / 消息重组 / 交付」留在 `WsConnection`。
 *
 * ## 关键约束（都来自规范，改前先读）
 *
 * - **掩码位必须与角色相符**（§5.1）：服务端收到的帧**必须**掩码，客户端收到的帧**必须**不掩码；
 * - **长度字段有扩展编码**：126/127 是**转义标记**而不是长度（16 位 / 64 位大端随后）；
 * - **单帧声明长度上限**：长度是**对端声明**的 64 位数，无上限就等着被「声明巨大长度后不发数据」耗死；
 * - **关闭帧载荷**：2 字节大端状态码 + UTF-8 原因，总长 ≤125。
 *
 * @maturity L1 — 分片 / 掩码 / 扩展长度 / 上限 判据经 `wsFrameConformance.test.ts` 钉死
 * @maturityEvidence tests/unit/wsFrameConformance.test.ts
 */
import { randomBytes } from 'node:crypto';

/** 已解析的一帧。 */
export interface WsParsedFrame {
  /** 是否为消息的最后一帧。 */
  readonly fin: boolean;
  /** 帧 opcode（数据帧 0x1/0x2/0x0，控制帧 0x8/0x9/0xa）。 */
  readonly opcode: number;
  /** 载荷（已解掩码）。 */
  readonly payload: Buffer;
}

/** 解析一步的结论（判别式：不用「默认值 / 异常」表达三种状态）。 */
export type WsFrameStep =
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'frame'; readonly frame: WsParsedFrame; readonly consumed: number }
  | {
      readonly kind: 'error';
      /** 关闭状态码（RFC6455 §7.4.1）。 */
      readonly code: number;
      /** 可读原因。 */
      readonly reason: string;
    };

/** RFC6455 帧编解码器（纯静态、无状态）。 */
export class WsFrameCodec {
  /**
   * 单帧声明长度上限（字节）：8 MiB。
   *
   * 依据：本服务的 WS 帧只承载 JSON-RPC 消息与事件推送（正常为 KB 级）；上限存在的意义是
   * 把「对端声明一个巨大长度后静默不发数据 ⇒ 服务端缓冲无限增长」这条内存耗尽路径封死。
   */
  public static readonly MAX_FRAME_BYTES = 8 * 1024 * 1024;

  /**
   * 解析缓冲中的**一帧**（不改动缓冲；调用方按 `consumed` 前进）。
   * @param buffer 当前缓冲
   * @param role 本端角色（决定掩码位是否必须置位）
   * @returns 结论：数据不足 / 一帧（含消费字节数）/ 协议错误（含关闭码）
   */
  public static parse(buffer: Buffer, role: 'server' | 'client'): WsFrameStep {
    if (buffer.length < 2) return { kind: 'incomplete' };
    const fin = ((buffer[0] ?? 0) & 0x80) !== 0;
    const opcode = (buffer[0] ?? 0) & 0x0f;
    const masked = ((buffer[1] ?? 0) & 0x80) !== 0;
    let length = (buffer[1] ?? 0) & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < offset + 2) return { kind: 'incomplete' };
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return { kind: 'incomplete' };
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    // 掩码位必须与角色相符（§5.1）：服务端收到的帧必须掩码，客户端收到的帧必须不掩码。
    if (masked !== (role === 'server')) {
      return {
        kind: 'error',
        code: 1002,
        reason: masked ? '服务端不得收到掩码帧' : '客户端帧必须掩码',
      };
    }
    let maskKey: Buffer | undefined;
    if (masked) {
      if (buffer.length < offset + 4) return { kind: 'incomplete' };
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (length > WsFrameCodec.MAX_FRAME_BYTES) {
      return { kind: 'error', code: 1009, reason: '单帧声明长度超过上限' };
    }
    if (buffer.length < offset + length) return { kind: 'incomplete' };
    const raw = buffer.subarray(offset, offset + length);
    const payload = maskKey === undefined ? raw : WsFrameCodec.unmask(raw, maskKey);
    return { kind: 'frame', frame: { fin, opcode, payload }, consumed: offset + length };
  }

  /**
   * 构造数据帧（服务端不掩码；客户端按 §5.1 掩码）。
   * @param payload 载荷
   * @param opcode 帧 opcode（缺省 0x1 文本）
   * @param role 本端角色
   * @returns 完整帧字节
   */
  public static buildDataFrame(payload: Buffer, opcode: number, role: 'server' | 'client'): Buffer {
    const mask = role === 'client' ? randomBytes(4) : undefined;
    const body =
      mask === undefined
        ? payload
        : ((): Buffer => {
            const masked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i += 1) {
              masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
            }
            return masked;
          })();
    const short = payload.length < 126;
    const mid = !short && payload.length < 65536;
    const header = Buffer.alloc(short ? 2 : mid ? 4 : 10);
    header[0] = 0x80 | opcode;
    const maskBit = mask === undefined ? 0 : 0x80;
    if (short) {
      header[1] = maskBit | payload.length;
    } else if (mid) {
      header[1] = maskBit | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header[1] = maskBit | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    return mask === undefined ? Buffer.concat([header, body]) : Buffer.concat([header, mask, body]);
  }

  /**
   * 构造关闭帧载荷（2 字节大端状态码 + UTF-8 原因，总长 ≤125）。
   * @param code 状态码
   * @param reason 原因文本（按字节截断到 123 以内）
   * @returns 载荷
   */
  public static closePayload(code: number, reason: string): Buffer {
    const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123);
    const head = Buffer.alloc(2);
    head.writeUInt16BE(code, 0);
    return Buffer.concat([head, reasonBytes]);
  }

  /**
   * 把完整消息载荷解码为文本（**严格 UTF-8**，RFC6455 §8.1：非法即失败）。
   *
   * 为什么要严格：宽松解码会把非法序列静默替换成 U+FFFD，上层拿到的是"看似合法"的坏数据——
   * 与「静默 ≠ 不可见」同一取向，这里宁可断开也不猜。
   * @param payload 完整消息载荷
   * @returns 文本；非法时为 `{ok:false, code, reason}`（按 §8.1 应 1007 关闭）
   */
  public static decodeText(
    payload: Buffer,
  ):
    | { readonly ok: true; readonly text: string }
    | { readonly ok: false; readonly code: number; readonly reason: string } {
    try {
      return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(payload) };
    } catch {
      return { ok: false, code: 1007, reason: '文本帧不是合法 UTF-8' };
    }
  }

  /**
   * 解客户端掩码。
   * @param raw 掩码后的载荷
   * @param mask 4 字节掩码键
   * @returns 解掩码后的原始载荷
   */
  private static unmask(raw: Buffer, mask: Buffer): Buffer {
    const out = Buffer.alloc(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      out[index] = (raw[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    return out;
  }
}
