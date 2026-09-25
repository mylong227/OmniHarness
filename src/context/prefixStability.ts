/**
 * 前缀稳定性治理与复用率度量（零依赖）。
 *
 * 物理事实：上游 KV / prompt 缓存**只复用字节级公共前缀**。
 * 因此「下一轮请求与已缓存前缀的公共前缀占比」= 缓存命中率的上确界。
 * 这是一个 Harness 侧**完全可控、可机械测量**的变量，而竞品普遍未量化（见 docs 20）。
 *
 * 本模块把该变量变成一个可证明的指标：
 *   prefixReuse(cached, incoming) = |commonPrefix| / |cached| ∈ [0,1]
 * 并证明：经 buildStablePrompt 规范化后，同一逻辑状态的所有抖变体 reuse ≡ 1。
 */

import { Canonical } from './canonical.js';

/**
 * 前缀稳定性度量器。
 *
 * 无状态、无 IO：同一实例可并发复用（默认实例见文件末尾组合根门面）。
 * `OOP 收口`（2026-09-11）：原静态方法族改为实例方法，消除 `static`。
 */
export class PrefixStability {
  /** 字节级公共前缀长度（UTF-16 code unit 计）。 */
  public commonPrefixLength(a: string, b: string): number {
    const limit = Math.min(a.length, b.length);
    let i = 0;
    while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) {
      i += 1;
    }
    return i;
  }

  /**
   * 前缀复用率：以 `cached` 为已缓存前缀时，`incoming` 能复用的比例。
   * 定律：prefixReuse(x, x) ≡ 1；prefixReuse 对第二参数非递减于公共前缀。
   */
  public prefixReuse(cached: string, incoming: string): number {
    if (cached.length === 0) {
      return 1;
    }
    return this.commonPrefixLength(cached, incoming) / cached.length;
  }

  /** 按 (tier, key) 规范排序后拼接——使分片遍历顺序不再影响字节输出。 */
  public buildStablePrompt(
    segments: readonly PromptSegment[],
    options: PromptBuildOptions = {},
  ): string {
    const ordered = [...segments].sort((left, right) => {
      if (left.tier !== right.tier) {
        return left.tier - right.tier;
      }
      if (left.key === right.key) {
        return 0;
      }
      return left.key < right.key ? -1 : 1;
    });
    const parts: string[] = [];
    for (const segment of ordered) {
      const body = options.scrub === true ? Canonical.scrubVolatile(segment.text) : segment.text;
      parts.push(`\n## ${segment.key}\n${body}`);
    }
    return parts.join('');
  }

  /** 确定性线性同余伪随机（零依赖，保证抖动可复现）。 */
  private lcg(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  /** 确定性洗牌：模拟注册表 / 遍历顺序在不同运行间的抖动。 */
  public reorderDeterministic<T>(items: readonly T[], seed: number): T[] {
    const random = this.lcg(seed);
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const a = out[i];
      const b = out[j];
      if (a !== undefined && b !== undefined) {
        out[i] = b;
        out[j] = a;
      }
    }
    return out;
  }

  /** 生成固定长度的十六进制串（严格定长，保证可被 scrubVolatile 完整匹配）。 */
  private hexDigits(random: () => number, digits: number): string {
    let out = '';
    while (out.length < digits) {
      out += Math.floor(random() * 16).toString(16);
    }
    return out.slice(0, digits);
  }

  /** 注入易变片段（时间戳 / UUID / pid），模拟真实运行时噪声。 */
  public injectVolatile(text: string, seed: number): string {
    const random = this.lcg(seed);
    const stamp = new Date(1700000000000 + Math.floor(random() * 1e9)).toISOString();
    // 严格 8-4-4-4-12，与 scrubVolatile 的 UUID 正则完全对齐（否则残留噪声会打断前缀）。
    const uuid = `${this.hexDigits(random, 8)}-${this.hexDigits(random, 4)}-${this.hexDigits(random, 4)}-${this.hexDigits(random, 4)}-${this.hexDigits(random, 12)}`;
    return `${text}\n<!-- trace=${uuid} at ${stamp} pid=${1000 + Math.floor(random() * 9000)} -->`;
  }

  /** 生成一个抖变体：分片顺序重排 + 注入易变片段。 */
  public jitterSegments(
    segments: readonly PromptSegment[],
    seed: number,
  ): readonly PromptSegment[] {
    return this.reorderDeterministic(segments, seed).map((segment) => ({
      ...segment,
      text: this.injectVolatile(segment.text, seed),
    }));
  }

  /**
   * 度量「第 1 轮真实请求」与「第 i 轮真实请求」之间的前缀复用率。
   *
   * 物理模型：真实运行时**每一轮**请求都携带时间戳 / traceId / pid，
   * 因此基准也必须是抖变体（而非无噪声的干净态），否则是拿理想态对比真实态，虚高。
   *
   * `canonical` 为 true 时走规范化（排序 + 擦除），用于证明规范化把复用率提到 1。
   */
  public measurePrefixStability(
    segments: readonly PromptSegment[],
    variantCount: number,
    canonical: boolean,
  ): PrefixStabilityReport {
    const build = (input: readonly PromptSegment[]): string =>
      this.buildStablePrompt(input, { scrub: canonical });
    const count = Math.max(1, variantCount);
    const base = build(this.jitterSegments(segments, 1));
    let sum = 0;
    let min = 1;
    for (let i = 1; i <= count; i += 1) {
      const reuse = this.prefixReuse(base, build(this.jitterSegments(segments, i)));
      sum += reuse;
      if (reuse < min) {
        min = reuse;
      }
    }
    return {
      samples: count,
      meanReuse: sum / count,
      minReuse: min,
      baseBytes: base.length,
    };
  }

  /** 字节级公共前缀长度（UTF-16 code unit 计）。 */
  public static commonPrefixLength(a: string, b: string): number {
    return prefixStability.commonPrefixLength(a, b);
  }

  /**
   * 前缀复用率：以 `cached` 为已缓存前缀时，`incoming` 能复用的比例。
   * 定律：prefixReuse(x, x) ≡ 1；prefixReuse 对第二参数非递减于公共前缀。
   */
  public static prefixReuse(cached: string, incoming: string): number {
    return prefixStability.prefixReuse(cached, incoming);
  }

  /** 按 (tier, key) 规范排序后拼接——使分片遍历顺序不再影响字节输出。 */
  public static buildStablePrompt(
    segments: readonly PromptSegment[],
    options: PromptBuildOptions = {},
  ): string {
    return prefixStability.buildStablePrompt(segments, options);
  }

  /** 确定性洗牌：模拟注册表 / 遍历顺序在不同运行间的抖动。 */
  public static reorderDeterministic<T>(items: readonly T[], seed: number): T[] {
    return prefixStability.reorderDeterministic(items, seed);
  }

  /** 注入易变片段（时间戳 / UUID / pid），模拟真实运行时噪声。 */
  public static injectVolatile(text: string, seed: number): string {
    return prefixStability.injectVolatile(text, seed);
  }

  /** 生成一个抖变体：分片顺序重排 + 注入易变片段。 */
  public static jitterSegments(
    segments: readonly PromptSegment[],
    seed: number,
  ): readonly PromptSegment[] {
    return prefixStability.jitterSegments(segments, seed);
  }

  /**
   * 度量「第 1 轮真实请求」与「第 i 轮真实请求」之间的前缀复用率。
   *
   * 物理模型：真实运行时**每一轮**请求都携带时间戳 / traceId / pid，
   * 因此基准也必须是抖变体（而非无噪声的干净态），否则是拿理想态对比真实态，虚高。
   *
   * `canonical` 为 true 时走规范化（排序 + 擦除），用于证明规范化把复用率提到 1。
   */
  public static measurePrefixStability(
    segments: readonly PromptSegment[],
    variantCount: number,
    canonical: boolean,
  ): PrefixStabilityReport {
    return prefixStability.measurePrefixStability(segments, variantCount, canonical);
  }
}

// ---- 门面兼容：保留原导出名，委托默认实例 ----
const prefixStability = new PrefixStability();

/** 提示词分片。tier 越小越稳定、越靠前（system=0 → tools=1 → history=2 → user=3）。 */
export interface PromptSegment {
  readonly key: string;
  readonly tier: number;
  readonly text: string;
}

/** 构建选项。 */
export interface PromptBuildOptions {
  /** 是否擦除易变片段（时间戳 / UUID / 临时路径 / pid）。默认 false。 */
  readonly scrub?: boolean;
}

/** 前缀复用率度量结果。 */
export interface PrefixStabilityReport {
  /** 参与比较的抖变体数量（含基准自身）。 */
  readonly samples: number;
  /** 平均前缀复用率 ∈ [0,1]。1 = 全部请求共享完整前缀（缓存可 100% 命中）。 */
  readonly meanReuse: number;
  /** 最差复用率。 */
  readonly minReuse: number;
  /** 基准前缀字节数。 */
  readonly baseBytes: number;
}
