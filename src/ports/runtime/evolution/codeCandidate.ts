/**
 * @beta
 * 一个待验证的代码候选（由 RLVR 采样器产出）。
 *
 * 2026-10-11 从 `src/evolution/rlvrLoop.ts` 外迁至端口层：`ports/runtime/evolution/
 * evolutionControllerOptions.ts` 需要用 RLVR 契约表达配置面，而类型原先住在实现文件里
 * ⇒ 触发 `architectureGate` 的 `ports→实现层` 禁边。类型本身不含实现，属端口层该有的东西；
 * 原位置改为导入 + 再导出，6 个消费方（`cascadeReward` / `inMemoryReplayBuffer` /
 * `rlvrController` / `verifiableReward` / `bucketedCoverageMeter` / `rlvrLoop`）零改动。
 */
export interface CodeCandidate {
  /** 候选唯一 id。 */
  readonly id: string;
  /** 候选代码（待编译/测试验证）。 */
  readonly code: string;
  /** 任意诊断元信息。 */
  readonly meta?: Readonly<Record<string, unknown>>;
}
