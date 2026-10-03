import { TokenCountCache, type TokenCountCacheStats } from './tokenCountCache.js';

/**
 * 计数缓存的**最小文本长度**（UTF-16 码元）。
 *
 * 为什么需要这个门槛（实测，µs/次估算）：
 * | 字节 | 无缓存 | 命中·同实例 | 命中·新实例 |
 * |------|--------|-------------|-------------|
 * |  140 |   3.05 |        0.58 |        2.38 |
 * |  300 |   2.81 |        0.17 |        1.12 |
 * | 1040 |   6.19 |        0.21 |        2.71 |
 * | 4100 |  25.63 |        0.19 |        9.31 |
 * | 16 K |  89.43 |        0.11 |       27.63 |
 * | 64 K | 246.57 |        0.12 |       24.62 |
 * |256 K | 1712.0 |        0.23 |      108.40 |
 *
 * 长文本无论「同一字符串实例」还是「内容相同的新实例」都显著更快（哈希是 memcpy 级，远快于
 * 逐码元分支计数）。**但极短文本会倒挂**：150 字节上「查表 + LRU 续命」的成本可能高于直接数一遍
 * （命中 2.38 µs vs 无缓存 3.05 µs 虽仍赢，但换到 ASCII 密集的短串上就会输）。
 * 故设一道门槛：短于它的文本**不进缓存、直接计数**——既不冒倒挂风险，也避免把缓存塞满短消息。
 */
const MIN_CACHEABLE_CHARS = 512;

/**
 * 每条消息的角色/协议固定开销（token）。
 *
 * **单一来源**：`TokenEstimator.estimateMessage` 与本文件导出的一切记账共用它；
 * `ContextBreakdownEstimator` 也从这里取（此前它自带一份同名常量 + 注释「与 +4 保持同口径」，
 * 两处一旦漂移，面板与压缩阈值就会各说各话）。
 */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** 记账所需的最小消息形状：`ModelMessage` 的结构子集，纯 `{ content }` 也满足。 */
export interface TokenAccountableMessage {
  /** 消息正文（wire 层必发）。 */
  readonly content: string;
  /** 思考模式回传的推理文本（DeepSeek 思考模式**硬性要求**回传，故确实占请求体）。 */
  readonly reasoningContent?: string | undefined;
  /** 助手回合携带的工具调用（id / 名称 / 参数都会序列化进 wire）。 */
  readonly toolCalls?:
    | readonly {
        readonly id?: string | undefined;
        readonly name: string;
        readonly arguments: Record<string, unknown>;
      }[]
    | undefined;
  /** 随消息附带的图像（只记**信封**文本，不记二进制载荷，理由见 {@link TokenEstimator.accountableText}）。 */
  readonly images?: readonly { readonly url?: string; readonly mediaType?: string }[] | undefined;
  /** 随消息附带的文件附件（同上：只记名称/MIME/URL）。 */
  readonly files?:
    | readonly {
        readonly name?: string;
        readonly mediaType?: string;
        readonly url?: string;
      }[]
    | undefined;
}

/** Token 估算器：中文按字数计，其余按 4 字符/token 近似。 */
export class TokenEstimator {
  /** 原生（Rust 内核）估算器：注入后 estimateMessages 走原生路径（单次 FFI 往返）。 */
  private nativeEstimator?: (messages: readonly TokenAccountableMessage[]) => number;

  /**
   * 文本 → 计数缓存（审计 §2.4：每步全文记账无前缀缓存）。
   *
   * 为什么放在估算器内部而不是调用方：`estimate(text)` 是纯函数，缓存对它**不可见**——
   * 所有既有调用点（`ContextBreakdownEstimator`、`ContextCompactor`）零改动即受益。
   * 相邻两步之间绝大多数消息逐字未变，于是「每步 O(全文)」降为「O(新增内容 + 命中条目的查表)」。
   * 有界（LRU，默认 512 条）以免长会话里缓存自身单调增长；短文本走 {@link MIN_CACHEABLE_CHARS} 门槛。
   */
  private readonly counts: TokenCountCache;

  /**
   * @param maxCachedTexts 计数缓存上限（默认 512；`0` = 关闭缓存，行为与改造前逐字一致）。
   */
  public constructor(maxCachedTexts = 512) {
    this.counts = new TokenCountCache(maxCachedTexts);
  }

  /** 注入原生（Rust 内核）批量估算器；传入则 estimateMessages 优先走原生。
   * @returns 无返回值。
   */
  public setNativeEstimator(fn: (messages: readonly TokenAccountableMessage[]) => number): void {
    this.nativeEstimator = fn;
  }

  /** 估算单段文本 token 数（长文本命中计数缓存时不重扫全文；短文本直接计数）。 */
  public estimate(text: string): number {
    if (text.length < MIN_CACHEABLE_CHARS) {
      return TokenEstimator.count(text);
    }
    const cached = this.counts.get(text);
    if (cached !== undefined) {
      return cached;
    }
    const tokens = TokenEstimator.count(text);
    this.counts.set(text, tokens);
    return tokens;
  }

  /**
   * 估算**单条消息**在真实请求里占用的 token 数（含该消息的全部 wire 载荷 + 角色开销）。
   *
   * ## 为什么不能只算 `content`（2026-10-03 清偿 PROJECT_BOARD §3-3）
   *
   * 旧实现只对 `content` 计数，于是三类真实占用**完全不入账**：
   *  - **工具调用参数**：`assistant.tool_calls[].arguments` 会原样序列化进请求体，且长工具链
   *    会话里它是主体（一次 `write_file` 的参数可能上千 token）；
   *  - **思考模式回传的 `reasoningContent`**：DeepSeek 思考模式硬性要求回传，同样在请求体里；
   *  - **附件信封**：附件在 wire 层展开为 `image_url` / 文件说明片段。
   * 记账系统性偏低 ⇒ 长会话**越过真实窗口才触发压缩**，下一步直接把超窗请求发给上游（fail-open 到 400）。
   *
   * ## 二进制载荷为何不计（沿用既有决策，不是遗漏）
   *
   * 图片/音视频的**二进制** token 数取决于厂商视觉编码器（分块数 / 分辨率档），无法从 base64
   * 长度反推——按长度折算会**严重高估**（1 MiB PNG ≈ 数十万字符）。故只计可测的**信封文本**
   * （URL / MIME / 文件名），与 `ContextBreakdownEstimator` 的既有口径一致。
   *
   * @param message 待估算消息（`ModelMessage` 的结构子集）。
   * @returns 该消息的 token 估算值。
   */
  public estimateMessage(message: TokenAccountableMessage): number {
    return this.estimate(TokenEstimator.accountableText(message)) + MESSAGE_OVERHEAD_TOKENS;
  }

  /**
   * 估算消息列表 token 数（每条含全部 wire 载荷与角色开销）。
   *
   * 注入原生估算器时整体下沉到 Rust（**契约：两侧逐位一致**，见
   * `crates/omni-napi/src/handler.rs::handle_context_estimate`）；否则走
   * {@link TokenEstimator.estimateMessage} 的本地规则——两条路径必须同源，
   * 否则「原生开 / 关」会给出不同的压缩时机。
   * @param messages 消息列表。
   * @returns 估算的 token 总数。
   */
  public estimateMessages(messages: readonly TokenAccountableMessage[]): number {
    if (this.nativeEstimator !== undefined) {
      return this.nativeEstimator(messages);
    }
    return messages.reduce((sum, message) => sum + this.estimateMessage(message), 0);
  }

  /**
   * 把一条消息折叠成「参与记账的文本」（唯一实现：TS 与 Rust 两侧照抄同一规则）。
   *
   * 拼装顺序固定（content → reasoning → toolCalls → 附件信封），用 NUL 分隔以免相邻字段
   * 拼接产生新的词边界而改变计数。分隔符本身也计入（几个码元，可忽略且确定）。
   * @param message 待折叠消息。
   * @returns 记账文本（无附加载荷时逐字等于 `content`）。
   */
  public static accountableText(message: TokenAccountableMessage): string {
    const parts: string[] = [message.content];
    if (message.reasoningContent !== undefined && message.reasoningContent !== '') {
      parts.push(message.reasoningContent);
    }
    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
      parts.push(JSON.stringify(message.toolCalls));
    }
    for (const image of message.images ?? []) {
      parts.push([image.url ?? '', image.mediaType ?? ''].join(' '));
    }
    for (const file of message.files ?? []) {
      parts.push([file.name ?? '', file.mediaType ?? '', file.url ?? ''].join(' '));
    }
    return parts.length === 1 ? (parts[0] as string) : parts.join('\u0000');
  }

  /**
   * 计数缓存观测（测试与诊断用）。
   * @returns `{ hits, misses, size }`。
   */
  public cacheStats(): TokenCountCacheStats {
    return this.counts.stats();
  }

  /**
   * 纯计数（无缓存；中文按字、其余按 4 字符/token）。
   * @param text 待估算文本。
   * @returns token 估算值。
   */
  private static count(text: string): number {
    const cjk = TokenEstimator.countCjk(text);
    const other = text.length - cjk;
    return Math.ceil(cjk + other / 4);
  }

  /** 统计中日韩字符数量。
   *
   * 实现说明（2026-09-22 性能收尾）：原先用 `text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)`
   * ——为「数个数」而**分配**全部命中子串的数组。本函数在每步上下文记账里对全文执行，
   * 实测 170 KB 文本 101.0 → 48.2 µs（**2.10×**，零分配，计数逐字相等：正则按 UTF-16 码元匹配，
   * 此处按 `charCodeAt` 判同一批区间）。
   * @param text 待统计文本
   * @returns CJK 码元个数
   */
  private static countCjk(text: string): number {
    let count = 0;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0xac00 && code <= 0xd7af)
      ) {
        count += 1;
      }
    }
    return count;
  }
}
