# 进化域架构升级方案（GEE Kernel v1 · 2026-10）

> **性质**：实施蓝图快照（带日期，按 [DOMAIN_SLICE_TEMPLATE.md](DOMAIN_SLICE_TEMPLATE.md) 七步法逐片可落地）。
> 决策记录：[adr/0008-governed-evolution-kernel.md](adr/0008-governed-evolution-kernel.md)（先于代码）。
> 机制择优依据：[EVOLUTION_RD_RESEARCH_2026-10.md](EVOLUTION_RD_RESEARCH_2026-10.md)；商业对位：[EVOLUTION_COMMERCIALIZATION_2026-10.md](EVOLUTION_COMMERCIALIZATION_2026-10.md)。
> 代码现状以 [PROJECT_BOARD.md](PROJECT_BOARD.md) 为准；本文文件路径均为 2026-10-04 实读核对。

---

## 0. 一句话

把进化域从「runtime 里的可选控制器 + 六环散件」升格为**一等公民域**：一个 `EvolutionKernel`
编排「信号 → 档案 → 级联评估 → 门禁/准入 → 台账快照 → 晋升 → 回滚 → 观测」七环；
三件新增基础设施（信号面 / 晋升台账 / 级联评估）、一件升格（覆盖率分桶）、两件休眠执行体转正
（CRISPR / 固化器）——全部长在现有端口上，零新依赖，`kernel` 开关默认关、零破坏。

---

## 1. 现状架构（代码实测）

```
Agent（任务末，core/agent.ts L355–360）
  └─ runEvolutionIfEnabled(sessionId)
       └─ runtime.evolution: EvolutionController          ← ports/runtime/evolution/ 契约
            └─ RlvrEvolutionController（rlvrController.ts）
                 ├─ 内层 EvolutionControllerImpl
                 │    ├─ TwistDiscoveryEngine   发现：现有技能池燧-1 莫尔组合（构造时快照）
                 │    ├─ FailClosedEvolutionGate 门禁：moireEnergy 基准 + minGain
                 │    └─ RlvrLoop               RLVR：采样→verifyCommand 退出码奖励→绿样本
                 ├─ PromotionAdmission          准入：多样性闸 + 退火接受 + FailurePatternMiner
                 ├─ RewardCoverageMeter         覆盖率闸（全局口径，<0.6 整轮不晋升）
                 └─ onPromote → skillRegistry.replace + log 'evolution.promoted'
```

**六环真实状态与一处订正**（订正 `EVOLUTION_RD_RESEARCH` 沿用的"信号采集器是孤儿模块"表述）：

| 环     | 真实状态（实读代码）                                                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 信号   | `FailurePatternMiner` **并非孤儿**——`promotionAdmission.ts` L25 在用；但它只见**门禁拒绝的候选**（自参考），从未接入真实任务失败/成功数据（遥测/回合结局）。缺口是**信号源**，不是「没有调用方」 |
| 发现   | `TwistDiscoveryEngine` 只做技能池两两组合；**构造时快照**技能列表，运行中注册的新技能不进池                                                                                                      |
| 评估   | `VerifiableReward` 真跑 verifyCommand；无级联（每个候选付全量验证成本）；无 val/test 纪律闸                                                                                                      |
| 准入   | 多样性+退火真实现；覆盖率闸是**全局**口径（无工况分桶，所有候选挤同一比较空间）                                                                                                                  |
| 应用   | `onPromote` → `registry.replace` 真接线（runtime.ts L79–91）                                                                                                                                     |
| 回滚   | **缺**：晋升无快照、无还原（会话/代码级 rewind 不覆盖技能表）                                                                                                                                    |
| 执行体 | `CRISPRSkillEditor.queue()` / `CapabilityCrystallizer.observe()` 零生产调用（仅测试）                                                                                                            |

---

## 2. 目标架构（Kernel v1）

```
                                   ┌────────────────────────────────────────────┐
   RuntimeTelemetryPort(production)│  EvolutionKernel  implements               │
   回合结局 / 观测行 ───────────────▶│  EvolutionController（既有端口，core 零改） │
                                   │                                            │
   SignalSourcePort ──信号──▶ ① ingest    ② expand   ③ verify   ④ gate        │
     ├ 失败→FailureRecord[]──────────▶ 挖掘器/固化器  档案采样  级联奖励   门禁+准入+分桶覆盖率
     └ 成功→组合密度──────────────────▶ CapabilityCrystallizer.observe()         │
                                                                   │全过          │
   PromotionLedgerPort ◀──⑤ snapshotBefore ────────────────────────┤            │
     （哈希链追加，rollback(seq) 还原技能表）                          ▼            │
                                        ⑥ onPromote → skillRegistry.replace      │
                                        ⑦ 观测行 evolution.kernel.*              │
   CandidateArchivePort ◀── ②③ 之间：分桶保留精英、冻结不删除、新工况复活          │
   CRISPRSkillEditorPort ◀── 针对「既有技能」的改进提案 → 定点 patch + 差异测试    │
```

**关键决策与替代方案**（详见 ADR-0008 §替代方案）：

| 决策                                                  | 为什么不是替代方案                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Kernel **实现既有 `EvolutionController` 端口**        | `core/agent.ts` 与 `OmniHarnessRuntime.evolution` 契约零改动；`arch:gate` 无新边；关掉即回现状 |
| 台账自建（复用 `HashChain` 算法）而非复用 `AuditSink` | 台账需要"按 seq 还原技能表"的操作语义，与审计链的"动作证据"语义分离，避免互相污染              |
| 档案在进化域而非记忆域                                | 候选是待裁决对象不是已蒸馏事实；混入记忆会绕过晋升门禁                                         |
| 级联做成奖励包装器而非新门禁                          | 门禁语义（fail-closed 默认拒绝）不变，变的只是奖励的成本结构                                   |

---

## 3. 模块映射（逐文件：新增 / 改造 / 复用）

| 文件                                              | 动作                     | 职责与要点                                                                                                                                                           |
| ------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ports/runtime/evolution/signalSource.ts`     | **新增端口**             | `EvolutionSignalSourcePort { collect(): readonly EvolutionSignal }`；`EvolutionSignal { kind:'failure'\|'success', key, evidence, provenance }`                      |
| `src/ports/runtime/evolution/candidateArchive.ts` | **新增端口**             | `CandidateArchivePort { put(c, bucketKey), elites(bucketKey), freeze(key, reason), reviveFor(bucketKey) }`                                                           |
| `src/ports/runtime/evolution/promotionLedger.ts`  | **新增端口**             | `PromotionLedgerPort { snapshotBefore(skillList), append(entry), rollback(seq): SkillRestorePlan, verify() }`                                                        |
| `src/evolution/evolutionSignalCollector.ts`       | **新增实现**             | `EvolutionSignalCollector`：读 `RuntimeTelemetryPort.read()` production 行 + 会话结局 → 失败喂挖掘器 / 成功喂固化器密度；有界缓冲、确定性                            |
| `src/evolution/candidateArchiveImpl.ts`           | **新增实现**             | `BucketedCandidateArchive`：按工况桶保留精英（MAP-Elites 式）；`expiresAt` 冻结不删除，同桶复现复活                                                                  |
| `src/evolution/promotionLedgerImpl.ts`            | **新增实现**             | `HashChainPromotionLedger`：JSONL 追加（`.omniharness/evolution/ledger.jsonl`）+ seq/prev/hash（复用 `util/hashChain`）；快照 = 技能表全量（name+instructions+tags） |
| `src/evolution/cascadeReward.ts`                  | **新增实现**             | `CascadeReward`：静态预检（围栏配平/非空/禁用模式，纯函数）→ verifyCommand；短路即省全量；明细进覆盖率计量                                                           |
| `src/evolution/coverageBuckets.ts`                | **新增实现**             | `BucketedCoverageMeter`：包 `RewardCoverageMeter`，按桶覆盖率取**最差桶**做闸（防单桶好看整体难看的假象）                                                            |
| `src/evolution/evolutionKernel.ts`                | **新增实现（编排核心）** | `EvolutionKernel`：七环编排 + `autoRun` 透传 + 全程 try/catch fail-closed；实现 `EvolutionController`                                                                |
| `src/composition/runtime.ts`                      | **改造**                 | `evolutionRlvr.kernel===true` 时装配 Kernel（注入三端口 + CRISPR + 固化器），否则走现状路径                                                                          |
| `src/config/*`                                    | **改造**                 | `evolutionRlvr` 增子键：`kernel`（bool，默认 false）、`ledgerDir`（默认 `.omniharness/evolution`）、`archiveMaxPerBucket`；沿现有透传路径，严格校验                  |
| `src/adapters/skill/crisprSkillEditor.ts`         | **复用（转正）**         | Kernel 周期内为「针对既有技能的提案」产出 `CrisprEditSpec`（differentialTest = 基准不回退）→ `queue()` → `flush()`                                                   |
| `src/adapters/skill/capabilityCrystallizer.ts`    | **复用（转正）**         | 成功信号提高组合密度 → `observe()`；越阈冻结为原生技能（加法式，与晋升门禁互不越权）                                                                                 |
| `src/evolution/twistDiscoveryEngine.ts`           | **改造（小）**           | 发现候选源从「构造时快照」改为每轮读 `skillRegistry.list()`（修"新技能不进池"）+ 档案精英并入候选流                                                                  |
| `src/core/agent.ts`                               | **零改动**               | 触发点不变（Kernel.autoRun 即原语义）                                                                                                                                |

---

## 4. 实施切片（S1–S7，每片独立交付、独立提交、过全部门禁）

依赖图：`S1 → S2 → {S3, S4, S5, S6} → S7`；S3/S4/S5/S6 可并行。

| #   | 切片                | 内容                                                                                                     | 可证伪判据（离线，含变异）                                                                                                                                                                                        | 人日  |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| S1  | 端口 + 信号面       | 3 端口契约 + `EvolutionSignalCollector`                                                                  | 合成 production 观测行 → 失败签名进挖掘器、成功密度进固化器（端到端单测）；**变异**：掐断信号源 ⇒ 提案数与密度增量恒 0（红）；provenance 非 production 的行**不**入信号（沿遥测纪律）                             | 2–3   |
| S2  | Kernel 编排 + 装配  | `EvolutionKernel` + `runtime.ts` 分支 + 配置子键                                                         | 开关 off ⇒ `runtime.evolution` 行为与现状逐项等价（既有 `evolutionRlvrWiring` 判据全绿）；on ⇒ Kernel 实例且 `cycle()` 走七环；kernel 内部异常 ⇒ 只告警不影响主任务（沿 `evolution.cycle.failed` 口径）           | 3–4   |
| S3  | 晋升台账 + 回滚     | `HashChainPromotionLedger` + Kernel 快照→晋升→还原                                                       | 晋升前快照存在且 `verify()=ok`；`rollback(seq)` 后技能表与快照**逐条深相等**；**变异**：改台账中间条目 ⇒ `verify()` 红（篡改检出）；关台账 ⇒ 晋升被 fail-closed 拒绝（不允许"无快照晋升"）                        | 2–3   |
| S4  | 级联评估            | `CascadeReward` + verifyCommand 前置静态预检                                                             | 静态失败 ⇒ spawn **调用次数=0**（注入计数器断言短路）；静态通过 ⇒ 退出码语义与原 `VerifiableReward` 一致（不改变奖励口径）；明细 reason 分级 `static-fail` / `verified-pass` / `verified-fail` / `unverifiable:*` | 1.5–2 |
| S5  | 覆盖率分桶          | `BucketedCoverageMeter` + 闸改最差桶                                                                     | 同一候选集：分桶口径下各桶精英保留 ≥ 全局口径（不劣化）；**变异**：去分桶 ⇒ "单桶拥挤"场景最差桶覆盖率下降（红）；阈值沿用 `COVERAGE_THRESHOLD`（不改口径）                                                       | 1.5–2 |
| S6  | 执行体转正          | CRISPR 提案路径 + 固化器密度路径                                                                         | 端到端：真实形态提案 → CrisprEditSpec → 差异测试通过才应用、失败即回滚（复用其既有判据）；**变异**：绕过差异测试 ⇒ 红；固化只新增不删改（沿其铁律），越阈密度归零                                                 | 2–3   |
| S7  | CLI + 文档 + 成熟度 | `evolution status\|cycle\|rollback` 子命令；ARCHITECTURE_SPEC 归属表行；`@maturity` 声明（Kernel L1 起） | CLI 只读命令不触发改动（rollback 需 `--yes`）；`audit:maturity` 绿（新增引擎全部带 `@maturityEvidence`）；`arch:gate --strict` 绿（ports 纯度 / 无新环）                                                          | 1.5–2 |

总量 ≈ **14–19 人日**。每片完成后跑：`npm run check -- --strict`、`typecheck`、`lint`、
`audit:standard:delta`、`audit:maturity`、`arch:gate --strict`、`npm test`（新增判据文件全绿）。

> **基线说明（doc-links）**：§3 模块映射表中的目标路径在实现落地前**尚不存在**——它们是有意保留的
> 规划引用（蓝图的价值就在路径级精确），已按 `check:doc-links` 的既定出路（`--update`）纳入死链基线；
> 对应文件落地后应再跑 `--update` 把基线收紧回去（届时这些引用变为真实验证）。

---

## 5. 收益核算（为什么这个顺序最大化收益）

1. **S3（台账+回滚）是差异带本体**：外部自进化系统（DGM/OpenEvolve/ShinkaEvolve）全部没有
   "晋升可还原"语义——这一片把商业报告的"治理化自进化"主张从叙事变成机制，且 2–3 人日。
2. **S1（信号面）让存量价值流动**：挖掘器、固化器、（后续）CRISPR 的输入从此来自真实使用
   而非自参考；不接这片，其余机制都是"空转的精密仪器"。
3. **S2（Kernel）买的是可维护性**：六环从"组合根里的 30 行拼装"变成一个可单测、可观测、
   可替换的编排单元——后续任何一环升级（如自动课程实验档）都只动 Kernel 一处。
4. **S4/S5 是纯成本优化**：级联省验证次数（单人维护下评估是最稀缺资源）；分桶修的是
   "在错误空间比较"这一本仓实测反复出现的失败根因。
5. **顺序的抗中断性**：任意一片被砍，前面已合片的收益完整保留（每片独立提交，沿切片模板第 7 步）。

---

## 6. 边界（明确不做，沿反泡沫清单）

不进化代码与权重（DGM/AgentEvolver 主路径拒绝）；不引入向量库/图库/外部记忆系统；
不做 MCTS 工作流搜索；不把 LLM 裁判当完成判据；**增益未经两关统计前 kernel 保持默认关**，
对外不得声称"已实现自我进化"（沿 `EVOLUTION_RD_RESEARCH` §E2 纪律）；
不新增运行时依赖；不改动 `core/` 主循环形态。

---

## 7. 诚实清单

- 本文为**实施蓝图**，未实现未测量；S1–S7 判据落地前，Kernel 不存在于 `src/`。
- 人日为估算（沿看板口径，含测试），可能放大 2×。
- "成功信号喂固化器"的增益假设未验证（AWM/ExpeL 证据来自 web agent 域，外推是假设）；
  S1 判据只保证**接线真实性**，不保证增益。
- 台账快照含技能 instructions 明文——若技能含敏感内容，落盘位置须遵守既有
  `omniharness.json` 的个人数据纪律（S3 实现时核对 `check:secrets` 口径）。
