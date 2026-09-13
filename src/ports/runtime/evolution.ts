/**
 * 进化闭环端口（Evolvix 核心 / P1 首发块）。
 *
 * 把"经验 → 发现(DiscoveryEngine) → 评估(EvolutionGate) → 晋升"串成
 * fail-closed 的进化门禁：任何候选能力都必须过「真实基准评估 + 安全检查」才晋升，
 * 默认拒绝。这是 13_方案代码对账 判定的"决定性短板"——OmniHarness 此前完全没有
 * "把实验产出变成可复用、可评估、可晋升能力"的闭环管线。
 *
 * 本端口零依赖、零运行时负担：DiscoveryEngine 受 discoveryBudget 硬上限约束，
 * EvolutionGate 默认拒绝（fail-closed），晋升动作由调用方注入（如注册进 SkillRegistry）。
 *
 * @beta 属 P1 内核升级子系统，接口仍可能微调。
 */
import type { Skill } from '../../skill/skill.js';
import type { AuditSinkLike } from './supervisor.js';

/** 候选能力（待评估晋升者）：一个组合/发现的技能 + 其来源与诊断元信息。 */
export interface Candidate {
  /** 待晋升候选技能。 */
  readonly skill: Skill;
  /** 来源标识（如 'twist:a+b' / 'incumbent'）。 */
  readonly source: string;
  /** 任意诊断元信息（如涌现强度、转角）。 */
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

/** 晋升/隔离裁决（fail-closed 可读）。 */
export interface PromotionVerdict {
  /** 被裁决的候选。 */
  readonly candidate: Candidate;
  /** 是否被晋升（默认 false）。 */
  readonly promoted: boolean;
  /** 候选在基准上的得分 0..1。 */
  readonly score: number;
  /** 对照基线得分 0..1。 */
  readonly baselineScore: number;
  /** 安全检查结论。 */
  readonly safety: 'pass' | 'blocked';
  /** 裁决理由（可读，便于审计）。 */
  readonly reason: string;
}

/**
 * 进化门禁（fail-closed 评估 + 晋升）。
 * 任何候选必须过「真实基准评估 + 安全检查」才晋升；默认拒绝。
 */
export interface EvolutionGate {
  /** 用真实基准评估候选，返回是否晋升（含对照基线对比 + 安全结论）。 */
  evaluate(candidate: Candidate): Promise<PromotionVerdict>;
}

/**
 * 发现引擎（沙箱有界探索）：在 discoveryBudget 硬上限内生成候选能力。
 * 严禁在预算外自改；绝不暴露裸能力（颜色单态约束由上游 SupervisorPort 兜底）。
 */
export interface DiscoveryEngine {
  /** 生成下一批候选（受 budget 约束，返回空数组 = 预算耗尽）。 */
  nextCandidates(): Candidate[];
  /** 当前预算消耗情况。 */
  budgetUsed(): { readonly generated: number; readonly maxCandidates: number };
}

/** 进化控制器选项。 */
export interface EvolutionControllerOptions {
  /** 发现引擎（有界探索）。 */
  readonly discovery: DiscoveryEngine;
  /** 进化门禁（fail-closed 评估）。 */
  readonly gate: EvolutionGate;
  /**
   * 晋升回调：候选被门禁晋升后触发（如把技能注册进 SkillRegistry）。
   * 零依赖、由调用方注入，避免控制器反向依赖具体注册表。
   */
  readonly onPromote?: ((candidate: Candidate) => void) | undefined;
  /** 任务完成后自动跑一轮进化（默认 false，确保零破坏旁路）。 */
  readonly autoRun?: boolean | undefined;
  /** 可选审计 sink：每次裁决入哈希链。 */
  readonly audit?: AuditSinkLike | undefined;
  /**
   * (U4 升格) RLVR 阶段：每个过门禁的候选再跑一轮 sample-filter-replay，仅「绿」样本才晋升。
   * 缺省 undefined → 退化为原「门禁→晋升」单次闭环，零破坏。需由调用方注入 `RlvrLoop` 实例。
   */
  readonly rlvr?: {
    /** RLVR 主循环（采样→可验证奖励打分→绿样本进回放缓冲）。 */
    readonly loop: import('../../evolution/rlvrLoop.js').RlvrLoop;
    /** 从进化候选抽取 RLVR prompt；返回 undefined = 跳过该候选的 RLVR 阶段。 */
    readonly promptFor: (candidate: Candidate) => string | undefined;
  };
}

/** 进化控制器：编排 发现 → 评估 → 晋升 一轮闭环。 */
export interface EvolutionController {
  /** 评估单个候选（直接转发门禁）。 */
  evaluate(candidate: Candidate): Promise<PromotionVerdict>;
  /** 跑一轮：取本批候选 → 逐一评估 → 晋升者触发 onPromote。 */
  cycle(): Promise<readonly PromotionVerdict[]>;
  /** 当前预算消耗。 */
  budgetUsed(): { readonly generated: number; readonly maxCandidates: number };
  /** 是否任务完成后自动进化。 */
  readonly autoRun: boolean;
}
