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

/** Token 估算器：中文按字数计，其余按 4 字符/token 近似。 */
export class TokenEstimator {
  /** 原生（Rust 内核）估算器：注入后 estimateMessages 走原生路径（单次 FFI 往返）。 */
  private nativeEstimator?: (messages: readonly { content: string }[]) => number;

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
  public setNativeEstimator(fn: (messages: readonly { content: string }[]) => number): void {
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

  /** 估算消息列表 token 数（含每条角色开销）。 */
  public estimateMessages(messages: readonly { content: string }[]): number {
    if (this.nativeEstimator !== undefined) {
      return this.nativeEstimator(messages);
    }
    return messages.reduce((sum, message) => sum + this.estimate(message.content) + 4, 0);
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
