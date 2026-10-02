import type { DiscoveryEngine } from './discoveryEngine.js';
import type { EvolutionGate } from './evolutionGate.js';
import type { Candidate } from './candidate.js';
import type { AuditSinkLike } from '../supervisor.js';

/** 进化控制器选项。 */
export interface EvolutionControllerOptions {
  /** 发现引擎（有界探索）。 */
  readonly discovery: DiscoveryEngine;
  /** 进化门禁（fail-closed 评估）。 */
  readonly gate: EvolutionGate;
  /**
   * 晋升回调：候选被门禁晋升后触发（如把技能注册进 SkillRegistry）。
   * 无第三方依赖、由调用方注入，避免控制器反向依赖具体注册表。
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
    readonly loop: import('../../../evolution/rlvrLoop.js').RlvrLoop;
    /** 从进化候选抽取 RLVR prompt；返回 undefined = 跳过该候选的 RLVR 阶段。 */
    readonly promptFor: (candidate: Candidate) => string | undefined;
  };
}
