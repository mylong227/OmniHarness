# 0008 治理化进化内核（EvolutionKernel 一等域升格）

- 日期：2026-10-04
- 状态：已接受（实施蓝图见 [../EVOLUTION_ARCH_UPGRADE_2026-10.md](../EVOLUTION_ARCH_UPGRADE_2026-10.md)）

## 背景

进化闭环的六环（发现→门禁→RLVR→准入→覆盖率闸→晋升）分散在 `src/evolution/` 的多个类中，
由 `RlvrController.createRlvrEvolutionController` 拼装、`Runtime.createRuntime` 装配、
`Agent.runEvolutionIfEnabled` 触发。机制真实（`src/composition/runtime.ts` 的 onPromote 已接线），
但有三个结构性问题：

1. **信号源自参考**：`FailurePatternMiner` 由 `PromotionAdmission` 持有，但它的输入只有
   「门禁拒绝的候选」——进化系统从未见过真实任务的失败/成功数据（遥测、回合结局）。
2. **晋升不可回滚**：`onPromote` 直接 `registry.replace`，晋升前无快照、晋升后无还原路径——
   自进化缺少治理闭环的最后一环（对照：会话/代码级回滚已有 `checkpointManager`）。
3. **休眠执行体**：`CRISPRSkillEditor` / `CapabilityCrystallizer` 机制完整但零生产调用方；
   覆盖率只有全局口径（无工况分桶）；评估无级联（每次候选都付全量验证成本）。

## 决策

1. 新增 **`EvolutionKernel`**（`src/evolution/evolutionKernel.ts`）作为进化域唯一编排器，
   串起「信号采集 → 档案扩展 → 级联评估 → 门禁/准入 → 台账快照 → 晋升 → 观测」。
   **Kernel 实现既有 `EvolutionController` 端口**（`ports/runtime/evolution/`），因此
   `core/agent.ts` 的触发点与 `OmniHarnessRuntime.evolution` 契约零改动——架构升格发生在
   组合根与进化域内部，主循环形态不变。
2. 新增三个端口契约（与既有 6 文件同住 `ports/runtime/evolution/`）：
   `SignalSourcePort`（进化信号源）、`CandidateArchivePort`（候选档案：分桶保留 + 冻结/复活）、
   `PromotionLedgerPort`（晋升台账：哈希链追加 + 晋升前快照 + 按 seq 还原）。
3. 晋升路径改为**先快照后晋升**：`PromotionLedger.snapshotBefore()` → `registry.replace` →
   审计行；`rollback(seq)` 恢复技能表。台账复用 `util/hashChain`（语义同遥测链），防篡改。
4. 信号面接入生产数据：`EvolutionSignalCollector` 从 `RuntimeTelemetryPort` 的
   production 观测行提取失败/成功信号，喂给既有挖掘器与固化器（provenance 纪律不变：只认 production）。
5. 级联评估：静态预检（纯函数、零成本）先于 `verifyCommand`，短路即省全量验证；
   覆盖率闸升格为按工况分桶（MAP-Elites 式精英保留）。
6. 休眠执行体转正：Kernel 在周期内为「针对既有技能的改进提案」产出 `CrisprEditSpec`
   （差异测试 = 门禁基准非回退），为「高频成功组合」调用固化器 `observe()`。
7. **默认关、零破坏**：新路径由 `evolutionRlvr.kernel` 显式开启；关闭时组合根产出与现状逐行为等价的控制器。

## 后果

- 正面：六环闭环 + 回滚第七环补齐；治理能力（审计/快照/还原）成为对外差异带；
  已建成的休眠机制进入产线；信号面让进化随真实使用积累。
- 负面：进化域文件数增加（新增约 6 个实现文件 + 3 个端口契约）；台账持久化引入一处新落盘文件。
- 边界（沿既有红线）：不进化代码与权重；不引入向量库/图库；增益未经两关统计前保持默认关，
  不得对外声称"已实现自我进化"。

## 替代方案

- 在 `core/` 新增进化编排类——拒绝：违反六边形纪律（编排应住实现域，core 只认端口），
  且 `arch:gate --strict` 会红。
- 复用 `AuditSink` 作晋升台账——拒绝：审计链语义是"人/系统动作"证据，台账需要
  "按 seq 还原技能表"的操作语义，混用会让两种追责互相污染；但哈希算法与格式沿用同一 `HashChain`。
- 把候选档案放进长期记忆域——拒绝：候选是待裁决对象不是已蒸馏事实，混入记忆会绕过晋升门禁。
