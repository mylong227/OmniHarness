/**
 * 资产评估判据明细（Wave B 把它从实现层搬进端口：`EvaluatorPort` 的返回面是契约，不是实现细节）。
 *
 * 与 Wave A 的 `RewardCoverageMeter` 同口径（**该口径是诚实性的一部分**，不是实现选择）：
 * - `verifiable: true` = 真实判定过（**判负也是判定**，0 不是原罪）；
 * - `verifiable: false` = 没能验证（类型未注册 / 评估器抛错 / 契约不可用）——「没验过」不得冒充「验过」。
 *
 * 搬迁方式：本文件是唯一定义，`src/evolution/rewardCoverageMeter.ts` 原位置改为再导出，
 * 既有调用点与判据零改动（与 `ports/runtime/evolution.ts` 桶同一手法）。
 */
export interface RewardVerdict {
  /** 奖励值（0..1，与既有 VerifiableRewardFn 同口径）。 */
  readonly reward: number;
  /** 是否为「真实可验证判定」：false 表示未能验证（命令缺失/运行异常/空集），并非判负。 */
  readonly verifiable: boolean;
  /** 判定来源说明（verified-pass / verified-fail / unverifiable:<原因>）。 */
  readonly reason: string;
}
