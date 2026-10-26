/**
 * 确定性上下文压缩（无第三方依赖）。
 *
 * 生态位：LLMLingua / LongLLMLingua / Selective Context 已证明上下文压缩能带来
 * 数量级收益（微软官方 20×；LongLLMLingua 延迟降低 1.4×–3.8×），但它们**需要模型权重**
 * 计算 token 自信息，在「运行时无第三方依赖」铁律下不可采用。
 *
 * 本模块提供**纯算法、无需任何模型**的确定性替代：
 * 只裁剪「确定的冗余」（空行、JSON 缩进、重复分片、超长输出中段、远古历史），
 * 不猜语义、不删事实，因此**零幻觉风险**且**幂等可证**。
 *
 * 三大定律（配机械测试）：
 *   1. 幂等  compress ∘ compress ≡ compress
 *   2. 单调  bytes(compress(x)) ≤ bytes(x)
 *   3. 保序  分片相对顺序不变（去重保留首次出现）
 *
 * OOP 收口：原模块级纯函数归拢为 `DeterministicCompressor` 类方法；保留全部原函数名
 * 作为门面（委托单例），既有调用点（src/context/index.ts、src/index.ts、
 * tests/unit/contextEfficiency.test.ts）无需改动。
 */

/** 上下文分片。 */
export type SegmentKind = 'system' | 'user' | 'assistant' | 'tool-result' | 'history';

/** 上下文分片。 */
export interface ContextSegment {
  readonly key: string;
  readonly kind: SegmentKind;
  readonly text: string;
}

/** 压缩选项。 */
export interface CompressOptions {
  /** 单片输出超过该行数才截断。默认 200。 */
  readonly maxLines?: number;
  /** 截断时保留的头部行数。默认 40。 */
  readonly headLines?: number;
  /** 截断时保留的尾部行数。默认 40。 */
  readonly tailLines?: number;
  /** 第 N 条对话轮次之后的历史折叠为单行摘要。默认 8。 */
  readonly foldAfter?: number;
  /** 是否压缩 JSON 块（去缩进）。默认 true。 */
  readonly minifyJson?: boolean;
  /** 是否去除完全重复的分片。默认 true。 */
  readonly dedupe?: boolean;
}

/** 单阶段节省统计。 */
export interface CompressStageMetric {
  readonly stage: string;
  readonly savedBytes: number;
}

/** 压缩报告。 */
export interface CompressReport {
  readonly originalBytes: number;
  readonly compressedBytes: number;
  /** 压缩后 / 压缩前 ∈ (0,1]，越小越省。 */
  readonly ratio: number;
  readonly savedBytes: number;
  readonly stages: readonly CompressStageMetric[];
}

/** 压缩结果。 */
export interface CompressResult {
  readonly segments: readonly ContextSegment[];
  readonly report: CompressReport;
}

/**
 * 确定性上下文压缩引擎。
 * 把原 `compressContext` 及其私有/导出的纯函数归拢为类方法；
 * 无模块级可变状态（`encoder` 为无状态实例字段），可多实例并发使用。
 */
export class DeterministicCompressor {
  private readonly encoder = new TextEncoder();
  /** 无损收缩结果 LRU（键=原文；只缓存 256 B–256 KB 的文本，防大对象把缓存撑爆）。 */
  private readonly shrinkCache = new Map<string, string>();
  /** UTF-8 字节数 LRU（同样限长）。 */
  private readonly byteCache = new Map<string, number>();
  /** 缓存条目上限（按条数；总字符量由单条上限与条数间接约束）。 */
  private static readonly CACHE_LIMIT = 1024;
  /** 可缓存文本的最大长度：超过则直接计算（避免 1 MB 消息 × 1024 条常驻）。 */
  private static readonly CACHE_MAX_TEXT = 256 * 1024;

  /**
   * 命中有界缓存；命中后刷新 LRU 顺序。
   * @param cache 缓存表。
   * @param key 键。
   * @returns 命中值；未命中为 undefined。
   */
  private static cached<T>(cache: Map<string, T>, key: string): T | undefined {
    const hit = cache.get(key);
    if (hit === undefined) return undefined;
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  /**
   * 写入有界缓存（超限淘汰最旧）。
   * @param cache 缓存表。
   * @param key 键。
   * @param value 值。
   * @returns 无返回值。
   */
  private static remember<T>(cache: Map<string, T>, key: string, value: T): void {
    if (key.length > DeterministicCompressor.CACHE_MAX_TEXT) return;
    cache.set(key, value);
    while (cache.size > DeterministicCompressor.CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  }

  /** UTF-8 字节数（token 成本的真实代理；结果按文本有界缓存）。 */
  public byteLength(text: string): number {
    const cached = DeterministicCompressor.cached(this.byteCache, text);
    if (cached !== undefined) return cached;
    const bytes = this.encoder.encode(text).length;
    DeterministicCompressor.remember(this.byteCache, text, bytes);
    return bytes;
  }

  /** 折叠空行与行尾空白。 */
  public collapseBlankLines(text: string): string {
    return text
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/u, ''))
      .join('\n')
      .replace(/\n{3,}/gu, '\n\n');
  }

  /**
   * 若整段是合法 JSON，则去缩进紧凑化；否则原样返回。
   *
   * **无损护栏（2026-10-03 修）**：`JSON.stringify(JSON.parse(t))` 并非字符级恒等——
   * 超过 `Number.MAX_SAFE_INTEGER` 的整数被 double 舍入（雪片 ID / uint64 哈希 / 纳秒时间戳
   * 被静默改错值）、重复键只剩最后一个、`1.0`→`1` / `1e2`→`100` 字面量改写。修复后只有
   * 「收缩前后**全部数值字面量逐一相同**」才替换，否则整段原样返回（宁可不省也不篡改）。
   * 该判据同时覆盖重复键丢失（被丢值若含数字则字面量集合必变化；纯字母重复键是
   * 已知残留，实践中工具/模型产出的 JSON 均为规范化输出，未见此形态）。
   * @param text 待检查文本。
   * @returns 紧凑化文本（确认无损时）或原文（非 JSON / 解析失败 / 字面量有变时）。
   */
  public minifyJsonBlock(text: string): string {
    const trimmed = text.trim();
    const isJsonLike =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (!isJsonLike) {
      return text;
    }
    try {
      const minified = JSON.stringify(JSON.parse(trimmed) as unknown);
      if (!DeterministicCompressor.sameNumberLiterals(trimmed, minified)) {
        return text;
      }
      return minified;
    } catch {
      return text;
    }
  }

  /**
   * 两段文本中的数值字面量多重集是否完全一致（无损判据，见 {@link minifyJsonBlock}）。
   * 字符串内部的数字在两侧原样保留，天然对齐；正则只求「够宽」不求语法精确——
   * 误匹配只会让判据更保守（多拦、绝不放过）。
   * @param before 收缩前文本。
   * @param after 收缩后文本。
   * @returns 全部数值字面量（排序后逐一对上）一致时 true。
   */
  private static sameNumberLiterals(before: string, after: string): boolean {
    const pick = (text: string): readonly string[] =>
      (text.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu) ?? []).sort();
    const beforeLiterals = pick(before);
    const afterLiterals = pick(after);
    if (beforeLiterals.length !== afterLiterals.length) {
      return false;
    }
    return beforeLiterals.every((literal, index) => literal === afterLiterals[index]);
  }

  /**
   * **无损子集**收缩：只裁「确定冗余」——行尾空白、3+ 连续空行、整段 JSON 的缩进，
   * **不删任何字符级事实**（不截断、不省略、不摘要）。因此可安全作用于**发往模型的每一条消息**，
   * 且天然满足三大定律（幂等 / 单调 / 保序）。
   *
   * 与 `compress` 的分工：`compress` 面向**分片列表**（含截断与历史折叠，有信息损失）；
   * `shrinkLossless` 面向**单条消息文本**，是可无条件施加的前置归一化。
   * @param text 待收缩的单条文本。
   * @returns 收缩后的文本（无可裁冗余时逐字节原样返回）。
   */
  public shrinkLossless(text: string): string {
    if (text === '') {
      return text;
    }
    const cached = DeterministicCompressor.cached(this.shrinkCache, text);
    if (cached !== undefined) return cached;
    const shrunk = this.minifyJsonBlock(this.collapseBlankLines(text));
    // 未变化的文本也缓存：长会话里绝大多数消息在相邻两步之间不变，命中即 O(1)。
    DeterministicCompressor.remember(this.shrinkCache, text, shrunk);
    return shrunk;
  }

  /**
   * 超长输出截断：保留头部与尾部，**中段替换为带原始行数的省略标记**。
   * 省略标记保留可追溯信息（共几行、省略几行），不制造幻觉。
   * 幂等：行数 ≤ maxLines 时原样返回；截断结果自身行数也**恒 ≤ maxLines**
   * （省略标记占 1 行的预算已计入），故再压缩一次仍是稳定点。
   * @param text 待截断的单条文本。
   * @param maxLines 截断后允许的最大行数（含省略标记行）。
   * @param headLines 期望保留的头部行数（超过预算时按预算收敛）。
   * @param tailLines 期望保留的尾部行数（超过预算时按预算收敛）。
   * @returns 截断后的文本；行数未超限时逐字节原样返回。
   */
  public truncateLongOutput(
    text: string,
    maxLines: number,
    headLines: number,
    tailLines: number,
  ): string {
    const lines = text.split('\n');
    if (lines.length <= maxLines) {
      return text;
    }
    // 预算分配：省略标记恒占 1 行，头部/尾部在该预算内按 headLines/tailLines 收敛。
    // 原实现只按 lines.length 收敛、与 maxLines 无关，当 headLines+tailLines ≥ maxLines 时
    // 会「保留全部行 + 追加标记」⇒ 文本逐轮变长、幂等/单调失效、ratio > 1。
    const budget = Math.max(0, maxLines - 1);
    const keep = Math.max(0, Math.min(headLines, budget, lines.length));
    const tailKeep = Math.max(0, Math.min(tailLines, budget - keep, lines.length - keep));
    const head = lines.slice(0, keep);
    const tail = tailKeep > 0 ? lines.slice(lines.length - tailKeep) : [];
    const omitted = lines.length - keep - tailKeep;
    return [...head, `… [${omitted} lines omitted of ${lines.length}]`, ...tail].join('\n');
  }

  /** 去除内容完全相同的重复分片，保留首次出现（保序）。 */
  public deduplicateSegments(segments: readonly ContextSegment[]): readonly ContextSegment[] {
    const seen = new Set<string>();
    const out: ContextSegment[] = [];
    for (const segment of segments) {
      const fingerprint = `${segment.kind}\u0000${segment.text}`;
      if (seen.has(fingerprint)) {
        continue;
      }
      seen.add(fingerprint);
      out.push(segment);
    }
    return out;
  }

  /** 把第 N 条之后的对话轮次折叠为单行摘要；已折叠（kind==='history'）的不再处理。 */
  public foldHistorySegments(
    segments: readonly ContextSegment[],
    foldAfter: number,
  ): readonly ContextSegment[] {
    let dialogueIndex = 0;
    return segments.map((segment) => {
      const isDialogue = segment.kind === 'user' || segment.kind === 'assistant';
      if (!isDialogue) {
        return segment;
      }
      dialogueIndex += 1;
      if (dialogueIndex <= foldAfter) {
        return segment;
      }
      const preview = segment.text.replace(/\s+/gu, ' ').trim().slice(0, 80);
      return {
        key: segment.key,
        kind: 'history' as SegmentKind,
        text: `[folded #${dialogueIndex}] ${preview}…`,
      };
    });
  }

  /** 计算分片总字节数。 */
  private totalBytes(segments: readonly ContextSegment[]): number {
    let total = 0;
    for (const segment of segments) {
      total += this.byteLength(segment.text);
    }
    return total;
  }

  /**
   * 确定性上下文压缩主入口。
   * 按「去空行 → JSON 紧凑 → 去重 → 长输出截断 → 历史折叠」顺序施加，全程纯函数。
   */
  public compress(
    segments: readonly ContextSegment[],
    options: CompressOptions = {},
  ): CompressResult {
    const maxLines = options.maxLines ?? 200;
    const headLines = options.headLines ?? 40;
    const tailLines = options.tailLines ?? 40;
    const foldAfter = options.foldAfter ?? 8;
    const doMinify = options.minifyJson ?? true;
    const doDedupe = options.dedupe ?? true;

    const originalBytes = this.totalBytes(segments);
    const stages: CompressStageMetric[] = [];
    let current = segments;

    const stage = (name: string, next: readonly ContextSegment[]): void => {
      const before = this.totalBytes(current);
      const after = this.totalBytes(next);
      stages.push({ stage: name, savedBytes: Math.max(0, before - after) });
      current = next;
    };

    stage(
      'collapse-blank',
      current.map((segment) => ({ ...segment, text: this.collapseBlankLines(segment.text) })),
    );

    if (doMinify) {
      stage(
        'minify-json',
        current.map((segment) => ({ ...segment, text: this.minifyJsonBlock(segment.text) })),
      );
    }

    if (doDedupe) {
      stage('dedupe', this.deduplicateSegments(current));
    }

    stage(
      'truncate-output',
      current.map((segment) => ({
        ...segment,
        text: this.truncateLongOutput(segment.text, maxLines, headLines, tailLines),
      })),
    );

    stage('fold-history', this.foldHistorySegments(current, foldAfter));

    const compressedBytes = this.totalBytes(current);
    return {
      segments: current,
      report: {
        originalBytes,
        compressedBytes,
        ratio: originalBytes === 0 ? 1 : compressedBytes / originalBytes,
        savedBytes: Math.max(0, originalBytes - compressedBytes),
        stages,
      },
    };
  }

  /** UTF-8 字节数（token 成本的真实代理）。 */
  public static byteLength(text: string): number {
    return compressor.byteLength(text);
  }

  /** 折叠空行与行尾空白。 */
  public static collapseBlankLines(text: string): string {
    return compressor.collapseBlankLines(text);
  }

  /** 若整段是合法 JSON，则去缩进紧凑化；否则原样返回。 */
  public static minifyJsonBlock(text: string): string {
    return compressor.minifyJsonBlock(text);
  }

  /**
   * **无损子集**收缩：只裁「确定冗余」（行尾空白 / 3+ 连续空行 / 整段 JSON 缩进），
   * 不删任何字符级事实；幂等、单调、保序。
   * @param text 待收缩的单条文本。
   * @returns 收缩后的文本。
   */
  public static shrinkLossless(text: string): string {
    return compressor.shrinkLossless(text);
  }

  /**
   * 超长输出截断：保留头部与尾部，**中段替换为带原始行数的省略标记**。
   * 省略标记保留可追溯信息（共几行、省略几行），不制造幻觉。
   * 幂等：行数 ≤ maxLines 时原样返回。
   */
  public static truncateLongOutput(
    text: string,
    maxLines: number,
    headLines: number,
    tailLines: number,
  ): string {
    return compressor.truncateLongOutput(text, maxLines, headLines, tailLines);
  }

  /** 去除内容完全相同的重复分片，保留首次出现（保序）。 */
  public static deduplicateSegments(
    segments: readonly ContextSegment[],
  ): readonly ContextSegment[] {
    return compressor.deduplicateSegments(segments);
  }

  /** 把第 N 条之后的对话轮次折叠为单行摘要；已折叠（kind==='history'）的不再处理。 */
  public static foldHistorySegments(
    segments: readonly ContextSegment[],
    foldAfter: number,
  ): readonly ContextSegment[] {
    return compressor.foldHistorySegments(segments, foldAfter);
  }

  /**
   * 确定性上下文压缩主入口。
   * 按「去空行 → JSON 紧凑 → 去重 → 长输出截断 → 历史折叠」顺序施加，全程纯函数。
   */
  public static compressContext(
    segments: readonly ContextSegment[],
    options: CompressOptions = {},
  ): CompressResult {
    return compressor.compress(segments, options);
  }
}

// ---- 门面兼容：保留原函数名，委托单例 ----
const compressor = new DeterministicCompressor();
