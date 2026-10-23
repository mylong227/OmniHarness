/**
 * LongMemEval-S 离线代理评测（2026-10-22，P2-7 第二片）。
 *
 * 不是官方 LongMemEval-S 的模型判分复刻，而是**本地可复核的检索命中代理**：
 * 给定 case 的事实池与问题，用真实 `LongTermMemoryPort.recall` 取 top-k，再看答案文本是否
 * 出现在召回内容中，报告 recall@k / MRR / 按 case 明细。规模小、可重复、零网络。
 */
export interface LongMemEvalFact {
  /** 事实文本。 */
  readonly text: string;
  /** 信任标注（可选）。 */
  readonly trust?: 'trusted' | 'untrusted' | undefined;
}

/** 一条评测用例。 */
export interface LongMemEvalCase {
  /** 用例 id。 */
  readonly id: string;
  /** 问题/查询。 */
  readonly question: string;
  /** 期望答案（用于命中判定，不做语义等价）。 */
  readonly answer: string;
  /** 事实池。 */
  readonly facts: readonly LongMemEvalFact[];
}

/** 单 case 结果。 */
export interface LongMemEvalCaseResult {
  /** 用例 id。 */
  readonly id: string;
  /** 是否 top-k 命中答案。 */
  readonly hit: boolean;
  /** 首次命中的 rank（1-based；未命中为 null）。 */
  readonly rank: number | null;
  /** 实际召回的文本。 */
  readonly retrieved: readonly string[];
}

/** 汇总结果。 */
export interface LongMemEvalReport {
  /** 用例数。 */
  readonly cases: number;
  /** 命中数。 */
  readonly hits: number;
  /** recall@k。 */
  readonly recallAtK: number;
  /** 平均倒数排名（未命中按 0）。 */
  readonly mrr: number;
  /** 逐 case 明细。 */
  readonly results: readonly LongMemEvalCaseResult[];
}

/** LongMemEval 代理评分器。 */
export class LongMemEval {
  /**
   * 评一组 case。
   * @param cases 用例。
   * @param recall 检索函数（真实记忆端口）。
   * @param k top-k。
   * @param trustedOnly 只保留可信事实（按 `fact.trust` 元数据；需检索返回事实）。
   * @returns 报告。
   */
  public static async score(
    cases: readonly LongMemEvalCase[],
    recall: (query: string, k: number) => Promise<readonly { text: string; trust?: string }[]>,
    k: number,
    trustedOnly = false,
  ): Promise<LongMemEvalReport> {
    const results: LongMemEvalCaseResult[] = [];
    for (const testCase of cases) {
      const retrievedRaw = await recall(testCase.question, k);
      const retrieved = retrievedRaw
        .filter((fact) => !trustedOnly || fact.trust !== 'untrusted')
        .map((fact) => fact.text);
      const answer = LongMemEval.normalize(testCase.answer);
      const rankIndex = retrieved.findIndex((text) => LongMemEval.normalize(text).includes(answer));
      results.push({
        id: testCase.id,
        hit: rankIndex >= 0,
        rank: rankIndex >= 0 ? rankIndex + 1 : null,
        retrieved,
      });
    }
    const hits = results.filter((result) => result.hit).length;
    const mrr =
      results.length === 0
        ? 0
        : results.reduce((sum, result) => sum + (result.rank === null ? 0 : 1 / result.rank), 0) /
          results.length;
    return {
      cases: results.length,
      hits,
      recallAtK: results.length === 0 ? 0 : hits / results.length,
      mrr,
      results,
    };
  }

  /**
   * 归一化（小写、压缩空白；不做语义/词干）。
   * @param text 原文。
   * @returns 归一化文本。
   */
  private static normalize(text: string): string {
    return text.toLowerCase().replace(/\s+/gu, ' ').trim();
  }
}
