/**
 * wasm 模块的内存声明解析（**资源硬上限**的前置检查；`BuiltinWasmRunner` 的资源面判据依赖它）。
 *
 * ## 为什么必须自己解析
 *
 * worker 的 `resourceLimits.maxOldGenerationSizeMb` 只约束 **V8 堆**，而 **wasm 线性内存不占 V8 堆**
 * ——一个声明 65536 页（4 GiB）内存的模块可以**绕过**堆上限。要让"内存硬上限"这句话成立，
 * 只有两条路：① 实例化前读模块自己的 memory 段（本文件）；② 事后检查（太晚，分配已经发生）。
 * 故取 ①。
 *
 * ## 解析口径（wasm 二进制规范）
 *
 * 段结构：`id(1) size(N) payload`。memory 段（id=5）的 payload 是 `count` + 各 `memtype`；
 * `memtype = limits`：`flags(1)`，然后 `min`（LEB128），`flags&0x01` 时再有 `max`（LEB128）。
 * - `flags & 0x01 === 0` ⇒ **无上限声明**（可无限 `grow`）⇒ 调用方必须按"不可信"处理；
 * - 页大小固定 64 KiB（规范常量）。
 *
 * @maturity L1 — 无内存段 / 有上限 / 无上限 / 多内存 / 畸形截断 五类解析判据钉死
 * @maturityEvidence tests/unit/wasmResourceLimits.test.ts
 */

/** 线性内存页大小（wasm 规范常量）。 */
export const WASM_PAGE_BYTES = 65_536;

/** 内存段 id。 */
const MEMORY_SECTION_ID = 5;

/** 单条内存的内存声明。 */
export interface WasmMemoryDecl {
  /** 初始页数（`min`）。 */
  readonly minPages: number;
  /** 最大页数（`max`）；**未声明上限时为 `undefined`** —— 调用方必须按"不可信"处理。 */
  readonly maxPages: number | undefined;
}

/** 解析结论。 */
export type WasmMemoryScan =
  | { readonly ok: true; readonly memories: readonly WasmMemoryDecl[] }
  | { readonly ok: false; readonly reason: string };

/** wasm 内存声明解析器（纯静态、无状态）。 */
export class WasmMemoryLimits {
  private constructor() {}

  /**
   * 读模块声明的内存（**实例化之前**）。
   * @param bytes 模块字节
   * @returns 各内存声明；畸形模块给可读原因
   */
  public static scan(bytes: Uint8Array): WasmMemoryScan {
    if (bytes.length < 8) return { ok: false, reason: '模块字节过短（不足 wasm 头）' };
    const magic = [0x00, 0x61, 0x73, 0x6d];
    for (let i = 0; i < magic.length; i += 1) {
      if (bytes[i] !== magic[i]) return { ok: false, reason: '不是 wasm 模块（魔数不符）' };
    }
    let offset = 8;
    while (offset < bytes.length) {
      const id = bytes[offset] ?? 0;
      const sizeRead = WasmMemoryLimits.readLeb(bytes, offset + 1);
      if (!sizeRead.ok) return sizeRead;
      const payloadStart = sizeRead.next;
      const payloadEnd = payloadStart + sizeRead.value;
      if (payloadEnd > bytes.length) {
        return { ok: false, reason: `段 ${String(id)} 长度越界（模块被截断）` };
      }
      if (id === MEMORY_SECTION_ID) {
        return WasmMemoryLimits.parseMemories(bytes, payloadStart, payloadEnd);
      }
      offset = payloadEnd;
    }
    // 无内存段 ⇒ 模块没有线性内存（合法：纯计算模块）。
    return { ok: true, memories: [] };
  }

  /**
   * 解析 memory 段 payload。
   * @param bytes 模块字节
   * @param start payload 起点
   * @param end payload 终点（不含）
   * @returns 解析结论
   */
  private static parseMemories(bytes: Uint8Array, start: number, end: number): WasmMemoryScan {
    const countRead = WasmMemoryLimits.readLeb(bytes, start);
    if (!countRead.ok) return countRead;
    const memories: WasmMemoryDecl[] = [];
    let cursor = countRead.next;
    for (let index = 0; index < countRead.value; index += 1) {
      const flags = bytes[cursor];
      if (flags === undefined || cursor >= end) {
        return { ok: false, reason: 'memory 段被截断（缺 limits 声明）' };
      }
      cursor += 1;
      const minRead = WasmMemoryLimits.readLeb(bytes, cursor);
      if (!minRead.ok) return minRead;
      cursor = minRead.next;
      let maxPages: number | undefined;
      if ((flags & 0x01) !== 0) {
        const maxRead = WasmMemoryLimits.readLeb(bytes, cursor);
        if (!maxRead.ok) return maxRead;
        if (maxRead.value < minRead.value) {
          return {
            ok: false,
            reason: `memory 段非法：max(${String(maxRead.value)}) < min(${String(minRead.value)})`,
          };
        }
        maxPages = maxRead.value;
        cursor = maxRead.next;
      }
      memories.push({ minPages: minRead.value, maxPages });
    }
    return { ok: true, memories };
  }

  /**
   * 读 LEB128 无符号整数。
   * @param bytes 字节
   * @param start 起点
   * @returns 值与该整数之后的偏移；畸形时给可读原因
   */
  private static readLeb(
    bytes: Uint8Array,
    start: number,
  ):
    | { readonly ok: true; readonly value: number; readonly next: number }
    | { readonly ok: false; readonly reason: string } {
    let result = 0;
    let shift = 0;
    let cursor = start;
    while (cursor < bytes.length) {
      const byte = bytes[cursor] ?? 0;
      result |= (byte & 0x7f) << shift;
      cursor += 1;
      if ((byte & 0x80) === 0) return { ok: true, value: result >>> 0, next: cursor };
      shift += 7;
      // 32 位 LEB128 最多 5 字节（规范上限）：超出即畸形，按可读原因拒。
      if (shift > 28) return { ok: false, reason: 'LEB128 整数超长（模块畸形）' };
    }
    return { ok: false, reason: 'LEB128 整数未终止（模块被截断）' };
  }
}
