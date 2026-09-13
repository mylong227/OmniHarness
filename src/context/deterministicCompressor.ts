/**
 * 确定性上下文压缩（零依赖）。
 *
 * 生态位：LLMLingua / LongLLMLingua / Selective Context 已证明上下文压缩能带来
 * 数量级收益（微软官方 20×；LongLLMLingua 延迟降低 1.4×–3.8×），但它们**需要模型权重**
 * 计算 token 自信息，在「零运行时依赖」铁律下不可采用。
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

  /** UTF-8 字节数（token 成本的真实代理）。 */
  public byteLength(text: string): number {
    return this.encoder.encode(text).length;
  }

  /** 折叠空行与行尾空白。 */
  public collapseBlankLines(text: string): string {
    return text
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/u, ''))
      .join('\n')
      .replace(/\n{3,}/gu, '\n\n');
  }

  /** 若整段是合法 JSON，则去缩进紧凑化；否则原样返回。 */
  public minifyJsonBlock(text: string): string {
    const trimmed = text.trim();
    const isJsonLike =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (!isJsonLike) {
      return text;
    }
    try {
      return JSON.stringify(JSON.parse(trimmed) as unknown);
    } catch {
      return text;
    }
  }

  /**
   * 超长输出截断：保留头部与尾部，**中段替换为带原始行数的省略标记**。
   * 省略标记保留可追溯信息（共几行、省略几行），不制造幻觉。
   * 幂等：行数 ≤ maxLines 时原样返回。
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
    const keep = Math.max(0, Math.min(headLines, lines.length));
    const tailKeep = Math.max(0, Math.min(tailLines, lines.length - keep));
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
}

// ---- 门面兼容：保留原函数名，委托单例 ----
const compressor = new DeterministicCompressor();

/** UTF-8 字节数（token 成本的真实代理）。 */
export function byteLength(text: string): number {
  return compressor.byteLength(text);
}

/** 折叠空行与行尾空白。 */
export function collapseBlankLines(text: string): string {
  return compressor.collapseBlankLines(text);
}

/** 若整段是合法 JSON，则去缩进紧凑化；否则原样返回。 */
export function minifyJsonBlock(text: string): string {
  return compressor.minifyJsonBlock(text);
}

/**
 * 超长输出截断：保留头部与尾部，**中段替换为带原始行数的省略标记**。
 * 省略标记保留可追溯信息（共几行、省略几行），不制造幻觉。
 * 幂等：行数 ≤ maxLines 时原样返回。
 */
export function truncateLongOutput(
  text: string,
  maxLines: number,
  headLines: number,
  tailLines: number,
): string {
  return compressor.truncateLongOutput(text, maxLines, headLines, tailLines);
}

/** 去除内容完全相同的重复分片，保留首次出现（保序）。 */
export function deduplicateSegments(
  segments: readonly ContextSegment[],
): readonly ContextSegment[] {
  return compressor.deduplicateSegments(segments);
}

/** 把第 N 条之后的对话轮次折叠为单行摘要；已折叠（kind==='history'）的不再处理。 */
export function foldHistorySegments(
  segments: readonly ContextSegment[],
  foldAfter: number,
): readonly ContextSegment[] {
  return compressor.foldHistorySegments(segments, foldAfter);
}

/**
 * 确定性上下文压缩主入口。
 * 按「去空行 → JSON 紧凑 → 去重 → 长输出截断 → 历史折叠」顺序施加，全程纯函数。
 */
export function compressContext(
  segments: readonly ContextSegment[],
  options: CompressOptions = {},
): CompressResult {
  return compressor.compress(segments, options);
}
