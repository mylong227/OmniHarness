/**
 * 进化门禁（fail-closed 实现，I-P1-4 保形 fail-closed 的实质落点）。
 *
 * 任何候选能力都必须过「真实基准评估 + 安全检查」才晋升，默认拒绝（fail-closed）。
 * 评估是可注入的：默认注入 `capabilityCoverage`（确定性能力覆盖基准），也可注入
 * `runEvalSuite` 之类重量级真实 Agent 基准——门禁本身不关心基准怎么算，只保证
 * "未过评估绝不晋升 + 安全不通过绝不晋升 + 每次裁决入审计链"。
 *
 * 这正是 11_总纲 要求的"保形 fail-closed"：分布的有限样本拒绝率由调用方基准保证，
 * 门禁提供不可绕过的默认拒绝语义。
 */
import type { AuditSinkLike } from '../ports/supervisor.js';
import type { Candidate, EvolutionGate, PromotionVerdict } from '../ports/evolution.js';

/** 基准函数：候选 → 0..1 得分。 */
export type Benchmark = (candidate: Candidate) => number | Promise<number>;

/** 安全检查：返回 false 即拒（fail-closed）。 */
export type SafetyCheck = (candidate: Candidate) => boolean | Promise<boolean>;

/** FailClosedEvolutionGate 选项。 */
export interface FailClosedEvolutionGateOptions {
  /**
   * 真实基准：候选 → 0..1 得分。缺省返回 0 → 候选永远不过评估（fail-closed 兜底，
   * 迫使调用方必须提供真实基准才可能产生晋升）。
   */
  readonly benchmark?: Benchmark;
  /**
   * 对照基线：
   * - 数字：固定阈值（如 0）；
   * - Candidate：取其基准得分作为基线（典型为当前最优单技能 incumbent）。
   * 默认 0。
   */
  readonly baseline?: number | Candidate;
  /** 须超过基线的最小增益（默认 0.05）。 */
  readonly minGain?: number;
  /** 安全检查（fail-closed）：返回 false 即拒（默认 pass）。 */
  readonly safety?: SafetyCheck;
  /** 可选审计 sink：每次裁决入哈希链。 */
  readonly audit?: AuditSinkLike;
  /** 会话标识（写入审计 detail）。 */
  readonly sessionId?: string;
}

/** 默认基准：未配置时返回 0，使任何候选都过不了评估（fail-closed 兜底）。 */
const NO_BENCHMARK: Benchmark = () => 0;

/**
 * 进化门禁（fail-closed）。
 */
export class FailClosedEvolutionGate implements EvolutionGate {
  private readonly benchmarkImpl: Benchmark;
  private readonly baseline: number | Candidate;
  private readonly minGain: number;
  private readonly safetyImpl?: SafetyCheck;
  private readonly audit?: AuditSinkLike;
  private readonly sessionId?: string;

  public constructor(opts: FailClosedEvolutionGateOptions = {}) {
    this.benchmarkImpl = opts.benchmark ?? NO_BENCHMARK;
    this.baseline = opts.baseline ?? 0;
    this.minGain = opts.minGain ?? 0.05;
    this.safetyImpl = opts.safety;
    this.audit = opts.audit;
    this.sessionId = opts.sessionId;
  }

  private async resolveBaselineScore(): Promise<number> {
    if (typeof this.baseline === 'number') return this.baseline;
    return await this.benchmarkImpl(this.baseline);
  }

  /**
   * 用真实基准评估单个候选并裁决是否晋升（fail-closed）。
   * 先跑安全检查（未过即拒绝且 score 记 0），再对比基准得分与基线 + minGain 阈值；
   * 每次裁决（无论晋升与否）都会写入审计链（如已配置）。
   * @param candidate 待评估的候选能力
   * @returns 晋升裁决（含得分、基线得分、安全结论与可读理由；默认拒绝）
   */
  public async evaluate(candidate: Candidate): Promise<PromotionVerdict> {
    const baselineScore = await this.resolveBaselineScore();

    const safetyPass = this.safetyImpl === undefined ? true : await this.safetyImpl(candidate);
    if (!safetyPass) {
      const verdict: PromotionVerdict = {
        candidate,
        promoted: false,
        score: 0,
        baselineScore,
        safety: 'blocked',
        reason: '安全检查未过（fail-closed 默认拒绝晋升）',
      };
      this.recordAudit(verdict);
      return verdict;
    }

    const score = await this.benchmarkImpl(candidate);
    const promoted = score >= baselineScore + this.minGain;
    const verdict: PromotionVerdict = {
      candidate,
      promoted,
      score,
      baselineScore,
      safety: 'pass',
      reason: promoted
        ? `得分 ${score.toFixed(3)} ≥ 基线 ${baselineScore.toFixed(3)} + 增益 ${this.minGain} → 晋升`
        : `得分 ${score.toFixed(3)} < 基线 ${baselineScore.toFixed(3)} + 增益 ${this.minGain} → 隔离（未达晋升阈值）`,
    };
    this.recordAudit(verdict);
    return verdict;
  }

  private recordAudit(verdict: PromotionVerdict): void {
    if (this.audit === undefined) return;
    this.audit.record({
      type: 'evolution',
      sessionId: this.sessionId,
      detail: {
        source: verdict.candidate.source,
        skill: verdict.candidate.skill.name,
        promoted: verdict.promoted,
        score: verdict.score,
        baselineScore: verdict.baselineScore,
        safety: verdict.safety,
        reason: verdict.reason,
      },
    });
  }
}
