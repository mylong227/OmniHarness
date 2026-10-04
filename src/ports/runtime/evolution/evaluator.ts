/**
 * 评估器端口（Wave B · ADR-0009 / EVOLVIX_SPEC §2）：资产**适应度**的写入面。
 *
 * 与 Wave A 的 `RewardCoverageMeter` / `CascadeReward` 的关系：那些是「技能候选的代码级可验证奖励」
 * （spawn `verifyCommand`）；本端口是**面向任意资产类型**的评估面——度量由该类型的
 * `CapabilitySchema.evalContract` 声明（Ω-4），评估器只负责「按声明量、如实记明细」。
 *
 * 失败语义（**与 Wave A 同一口径，不放松**）：
 * - 判定必须区分 `verifiable` / `unverifiable`：类型未注册、契约抛错、资产非法 ⇒ `verifiable: false`
 *   （**没验过不得冒充验过**——覆盖率诚实性是同一件事）；
 * - 评估器**绝不改资产本体**：它只出判据，`fitness` 的写入由注册表/调用方决定（单一写者）。
 */
import type { CapabilityRecord } from '../../capability/capabilityRecord.js';
import type { RewardVerdict } from './rewardVerdict.js';

/** 评估器端口：把一件资产量成一个判据明细。 */
export interface EvaluatorPort {
  /**
   * 评估一件资产。
   * @param record 资产实例（其 `schemaKind` 决定度量口径）
   * @returns 判据明细（fail-closed：任何「量不出来」的情形都是 `verifiable: false`）
   */
  evaluate(record: CapabilityRecord): Promise<RewardVerdict>;
}
