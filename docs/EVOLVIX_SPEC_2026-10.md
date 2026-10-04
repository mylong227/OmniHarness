# Evolvix-Ω 架构规格书（全新架构 · 2026-10）

> **性质**：**工程规格（实现级）**——回答"新架构到底长什么样、照什么建"。策略与波浪路线见
> [ARCHITECTURE_TARGET_2026-10.md](ARCHITECTURE_TARGET_2026-10.md)（v2）；Wave A 实施细则见
> [EVOLUTION_ARCH_UPGRADE_2026-10.md](EVOLUTION_ARCH_UPGRADE_2026-10.md)；现状权威见
> [ARCHITECTURE_SPEC.md](ARCHITECTURE_SPEC.md)；依赖准入见 [DEPENDENCY_POLICY.md](DEPENDENCY_POLICY.md)（D10）。
> **本规格未实现**：文中全部新契约/新模块为设计产物；每个波浪落码前先落对应 ADR（B/C/D 各一条）；
> 实现落地后由 `architectureSpec.test.ts` 范式的交叉核对判据逐条钉死。

---

## 0. 系统一句话与全景图

**一个把自身能力当作受治理状态的 agent 内核**：工具/技能/工作流/算子全部成为统一资产
（可注册、可进化、可审计、可回滚、可分发），执行底座与主循环形态不变。

```
┌─ L4 分发 ─────────────────────────────────────────────────────────────┐
│ AssetPackPort（签名包 .ohb+Ed25519） · RegistryMetadata（MCP 风格导出） │
└──────────────┬───────────────────────────────────────────────────────┘
┌─ L3 治理 ─────▼───────────────────────────────────────────────────────┐
│ PromotionLedgerPort（哈希链台账+回滚） · IsolationPort（信任-隔离阶梯）│
│ 晋升策略管线：DiversityGuard → AnnealedAcceptance → BucketedCoverage  │
└──────────────┬───────────────────────────────────────────────────────┘
┌─ L2 进化 ─────▼───────────────────────────────────────────────────────┐
│ EvolutionKernel（七环编排，实现既有 EvolutionController 端口）         │
│ OperatorPort（发现/变异/课程） · EvaluatorPort（verifyCommand/反馈/AB）│
│ CandidateArchivePort（分桶精英·冻结/复活） · SignalSourcePort（双源）  │
└──────────────┬───────────────────────────────────────────────────────┘
┌─ L1 资产 ─────▼───────────────────────────────────────────────────────┐
│ CapabilitySchemaRegistryPort（类型注册） · CapabilityRegistryPort（超集│
│ 扩展 SkillPort：register/replace/list/get + 按类型评估委托）           │
└──────────────┬───────────────────────────────────────────────────────┘
┌─ L0 底座（不变）▼──────────────────────────────────────────────────────┐
│ 审批→沙箱→执行→记录 fail-closed 链 · 审计哈希链 · checkpoint/rewind    │
│ 事件流单源（ADR-0005） · ModelPort/ToolPort/StoragePort 既有端口面     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 1. 核心数据契约

### 1.1 CapabilitySchema（资产类型描述符——L1 的核心，运行时可注册）

```ts
/** 资产类型描述符：一种"可进化对象"的完整自描述（Wave B 落 ports/capability/）。 */
export interface CapabilitySchema {
  /** 类型键（如 'skill' / 'workflow-template' / 'insight' / 'operator' / 'task-set'）。 */
  readonly kind: string;
  /** 契约版本（半自动迁移；跨版本注册须走迁移器）。 */
  readonly version: 1;
  /** 结构校验（fail-closed：非法资产在注册口即拒，类型作者声明判据）。 */
  validate(asset: unknown): { readonly ok: true } | { readonly ok: false; readonly reason: string };
  /** 评估契约：返回该类型资产的门禁基准函数（Ω-4：度量由类型作者声明）。 */
  evalContract(ctx: EvalContext): BenchmarkFn;
  /** 信任档与隔离档默认值（可被签名元数据收紧，不可放宽——§6 矩阵）。 */
  readonly defaultTrustTier: TrustTier;
  readonly defaultIsolation: IsolationLevel;
  /** 台账语义：该类型变更走哪条链、快照粒度（全表/单资产）。 */
  readonly ledgerSemantics: { readonly chain: 'promotion'; readonly snapshot: 'registry-full' };
}
```

### 1.2 CapabilityRecord（注册表内的资产实例）

```ts
/** 资产实例 = 资产本体 + 溯源 + 适应度 + 治理状态。 */
export interface CapabilityRecord {
  readonly asset: unknown; // 由所属 Schema.validate 把关
  readonly schemaKind: string;
  readonly lineage: {
    // 溯源（可渲染为"进化系谱"）
    readonly parents: readonly string[]; // 来源技能名 / 父候选
    readonly operator: string; // 产生它的算子（'twist:a+b' / 'crispr' / 'pack:install'）
    readonly bornAt: string; // ISO 时间
  };
  readonly fitness:
    | {
        // 最近一次评估（评估器写入，只增不改）
        readonly benchmark: number; // 0..1
        readonly evaluatedAt: string;
        readonly evaluator: string; // 评估器标识（审计对应）
      }
    | undefined;
  readonly governance: {
    readonly trustTier: TrustTier;
    readonly isolation: IsolationLevel;
    readonly state: 'active' | 'frozen' | 'revoked';
    readonly ledgerSeq: number | undefined; // 最近一次状态变化对应的台账序号
  };
}
```

### 1.3 台账条目（PromotionLedger JSONL 行格式）

```jsonc
{
  "seq": 41,
  "prev": "<64hex>",
  "hash": "<64hex>",
  "action": "promote | crispr-apply | freeze | revive | revoke | rollback | pack-install",
  "assetKind": "skill",
  "assetName": "refactor-extract",
  "operator": "rlvr:twist",
  "provenance": "production",
  "snapshotRef": "snapshots/0041.json", // 该条目**之前**的注册表全量快照（rollback 语义）
  "verdictSummary": "gate+rlvr+admission+coverage PASS",
  "ts": "...",
}
```

**三条链的分工（不混用，哈希算法同源 `util/hashChain`）**：`AuditSink`（人/系统动作证据，NUL 分隔）·
`RuntimeTelemetry`（运行观测，空格分隔）· `PromotionLedger`（资产状态变化，空格分隔，附快照引用）。

---

## 2. 端口清单（新增 8 / 扩展 1 / 保留全部既有）

| 端口                             | 层  | 关键签名                                                                                                               | 失败语义                                                              | Wave |
| -------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---- |
| **CapabilitySchemaRegistryPort** | L1  | `register(schema): void` · `schemaOf(kind)`                                                                            | 重复 kind / 未注册 kind 即抛错（fail-closed）                         | B    |
| **CapabilityRegistryPort**       | L1  | `SkillPort` 全量 **+** `put(record)` · `recordOf(name)` · `recordsOfKind(kind)` · `setGovernance(name, patch)`         | 非法资产/未注册类型即拒；governance 变更**必须**留台账                | B    |
| **SignalSourcePort**             | L2  | `collect(): readonly EvolutionSignal`                                                                                  | 只认 `provenance='production'` 遥测；缓冲有界，溢出丢最旧并计数       | A    |
| **CandidateArchivePort**         | L2  | `put(c, bucketKey)` · `elites(bucketKey)` · `freeze(name, reason)` · `reviveFor(bucketKey)`                            | 冻结不删除（`expiresAt` 模式）；同桶复现自动复活                      | A    |
| **PromotionLedgerPort**          | L3  | `snapshotBefore(registryFull): snapshotRef` · `append(entry): seq` · `rollback(seq): RestorePlan` · `verify()`         | **无快照不晋升**（调用方违反即拒）；`verify()` 检改/删/插三类篡改     | A    |
| **IsolationPort**                | L3  | `run(asset: CapabilityRecord, fn: () => Promise<T>): Promise<IsolationResult<T>>`                                      | 档位不可达 ⇒ **拒绝执行**（不静默降档）；降级必须显式配置             | C    |
| **OperatorPort**                 | L2  | `propose(ctx: EvolutionContext): readonly Candidate`                                                                   | 预算外不自改（沿 DiscoveryEngine 约束）；输出必须带 lineage           | B    |
| **EvaluatorPort**                | L2  | `evaluate(c: CapabilityRecord): Promise<RewardVerdict>`                                                                | 判定必须区分 verifiable / unverifiable（沿 RewardCoverageMeter 口径） | B    |
| AssetPackPort                    | L4  | `install(pack): InstallReport` · `metadataFor(kind): RegistryMetadata`                                                 | 无签名/验签失败在严格档即拒；安装必过 Schema.validate + 台账          | D    |
| 保留                             | —   | `EvolutionController`（6 文件）、`ModelPort`、`ToolPort`、`RuntimeTelemetryPort`、`SkillPort`（被超集扩展后原样保留）… | 全部不动                                                              | —    |

---

## 3. 模块清单（逐文件；新增 18 / 改造 4 / 不动其余）

```
src/ports/capability/            # L1 契约（Wave B；ports 恒第三方-free）
  capabilitySchema.ts  capabilityRecord.ts  capabilityRegistryPort.ts
  capabilitySchemaRegistryPort.ts  trustTier.ts  isolationLevel.ts
src/ports/evolution/…            # Wave A 新契约（与既有 6 文件同目录）
  signalSource.ts  candidateArchive.ts  promotionLedger.ts
src/ports/…（Wave B/C/D）
  evolution/operator.ts  evolution/evaluator.ts  runtime/isolation.ts  asset/assetPack.ts
src/capability/                  # L1 实现
  capabilitySchemaRegistry.ts      # 类型注册表（内存 Map + 签名元数据校验）
  capabilityRegistry.ts            # 统一注册表：内部持有既有 SkillRegistry（绞杀者第一态）
  schemas/skillSchema.ts           # 首个 CapabilitySchema：委托既有 moireEnergy 基准
src/evolution/                   # L2/L3 实现（Wave A 新增件）
  evolutionSignalCollector.ts               # 遥测 production 行 → 失败签名 / 成功密度
  bucketedCandidateArchive.ts      # 分桶精英 + 冻结/复活
  hashChainPromotionLedger.ts      # JSONL + HashChain + 快照引用（.omniharness/evolution/）
  cascadeReward.ts                 # 静态预检 → verifyCommand（快→慢短路）
  bucketedCoverageMeter.ts         # BucketedCoverageMeter（最差桶闸）
  evolutionKernel.ts               # 七环编排：ingest→expand→verify→gate→ledger→promote→emit
  signalIngestor.ts                # ring① 路由策略：failure→挖掘器（有界）/ success→固化器
  archiveCurator.ts                # ring② 档案纪律：入档→复活早前冻结者→冻结本轮 + 复核上限退役
  dormantExecutorActivation.ts     # ring⑥ 执行体转正：CRISPR 定点改进 + 固化器越阈冻结（加法式）
src/adapters/…
  enterprise/oidcSdkClient.ts      # A.5：openid-client+jose 适配器（自研 oidcClient.ts 转回退资产）
  daemon/cronerSchedule.ts         # A.5：croner 薄适配（自研解析保留）
crates/omni-wasmrt/              # Wave C：wasmtime 嵌入（经 omni-napi 暴露 IsolationPort 的 wasm 档）
```

**改造（不换语义）**：`twistDiscoveryEngine.ts`（候选源改每轮读注册表 + 档案精英并入）；
`composition/runtime.ts`（`evolutionRlvr.kernel===true` ⇒ 装配 Kernel，否则现状逐等价）；
`config/configError.ts` + `configFactory.ts`（白名单加 `evolutionRlvr.kernel|ledgerDir|archiveMaxPerBucket`
与新顶层 `capability` 命名空间：`{ sources: {...}, isolationDefaults: {...} }`，拼错即报错）；
`cli/exec.ts` + `cli/evolutionCommand.ts`（新增 `evolution status|cycle|rollback` 子命令，rollback / cycle 需 `--yes`；
`capability list|install` 属 Wave B/D，本片不做）。

**观测行（新增，全部 `log.info/warn` + 可选遥测记录）**：`evolution.kernel.cycle`（七环摘要）、
`evolution.signal.collected`（kind/count/provenance）、`evolution.archive.bucket`（分桶状态）、
`evolution.ledger.appended`（seq/action）、`evolution.ledger.rollback`（seq→快照）、
`capability.registered`（kind/name/trustTier）、`capability.isolation.denied`（档位不可达）。

---

## 4. 关键流程（时序级；每步标注失败语义）

### F1 任务末进化周期（`EvolutionKernel.cycle()`）

```
Agent.runEvolutionIfEnabled ──▶ kernel.cycle()
 ① ingest    SignalSource.collect() ──失败──▶ FailureRecord[] ──▶ 挖掘器提案
             └─成功密度──▶ CapabilityCrystallizer.observe()          [异常: 计数并跳过, 不中止]
 ② expand    档案精英(elites) + TwistDiscovery(注册表现值) ──▶ 候选流  [预算上限 maxCandidates]
 ③ verify    CascadeReward: 静态预检(纯函数) ─失败─▶ 短路(verify 未调用)
             └─▶ verifyCommand 退出码 ─▶ RewardVerdict(明细) ─▶ 覆盖率记账
 ④ gate      FailClosedEvolutionGate(minGain) → Admission(多样性+退火) → BucketedCoverage(最差桶)
             └─任一不过 ⇒ promoted=false, reason 注明闸位（只做减法）
 ⑤ ledger    对每个将晋升者: snapshotBefore(registryFull) ─失败─▶ **拒绝晋升**(无快照不晋升)
             └─▶ append(entry) → seq
 ⑥ promote   skillRegistry.replace + audit 行（既有 onPromote 路径不动）
 ⑦ emit      evolution.kernel.cycle 观测行 + 遥测记录（provenance=production）
 整体: try/catch 兜底 → log.warn('evolution.cycle.failed')，绝不连累主任务（既有口径）
```

### F2 回滚（`omniharness evolution rollback --seq N --yes`）

`ledger.read()` → 校验 `verify()` 通过 → `rollback(N)` 返回 RestorePlan（快照 00N.json 的注册表全量）
→ 逐资产 `registry.put`（不在快照中的现行资产 ⇒ 置 `frozen` 并补台账 `revoke`，**不静默删除**）
→ `evolution.ledger.rollback` 观测行。**判据**：回滚后 `recordsOfKind` 与快照逐条深相等。

### F3 资产安装（Wave D，`omniharness capability install pack.ohb`）

验签（identity Ed25519）→ Schema.validate → 信任/隔离档分配（只可收紧）→ IsolationPort 试运行
（沙盒内 evalContract 冒烟）→ 注册 + 台账 `pack-install`。任一步失败 ⇒ 拒装 + 原因可读（fail-closed）。

### F4 元晋升（Wave E，算子资产的"进化进化器"）

算子资产走**两层门禁**：自身 evalContract + 元门禁（固定、不可被进化）；默认要求人工审批
（`capability approve <name>`），两关统计显著才可转自动。

---

## 5. 持久化布局

```
.omniharness/evolution/
  ledger.jsonl          # 台账（追加 only，HashChain: seq/prev/hash，SEP=' '）
  snapshots/000N.json   # 晋升前注册表全量快照（kind/name/asset/governance）
  archive.json          # 候选档案（分桶精英 + 冻结项 expiresAt）
.omniharness/sessions/  # 既有会话 JSONL（不动）
.omni-checkpoints/      # 既有会话+代码快照（不动）
```

隐私口径沿既有纪律：快照含 instructions 明文 ⇒ 落盘目录遵守 `omniharness.json` 个人数据纪律，
`check:secrets` 扫描覆盖 `evolution/` 目录（Wave A S3 实现时核对）。

---

## 6. 信任-隔离矩阵（L3）

| trustTier             | 默认隔离   | 可执行位置                                                                       | 谁可授予                | 降档条件                        |
| --------------------- | ---------- | -------------------------------------------------------------------------------- | ----------------------- | ------------------------------- |
| `core`（内置）        | in-process | 主进程                                                                           | 出厂 / 人工             | 不可降档                        |
| `signed`（验签包）    | vm         | `node:vm`（现状 best-effort，如实标注）→ Wave C 后可选 isolated-vm（B 级判据）   | 验签通过 + Schema 校验  | 任何逃逸指标 ⇒ 拒执行           |
| `evolved`（进化产物） | **wasm**   | wasmtime 运行时（omni-wasm 产出的 .wasm 技能模块；fuel metering + 线性内存隔离） | 晋升门禁全过 + 台账在案 | 无快照/验签失败 ⇒ 拒晋升/拒执行 |
| 外部（MCP/A2A）       | 进程外     | 既有 mcp/a2a 通道 + SSRF/权限门禁                                                | 既有审批                | 既有口径                        |

规则：**档位只能收紧不能放宽**（签名元数据 ≤ Schema 默认 ≤ 运行时策略）；IsolationPort 对不可达
档位**拒绝执行**而非静默降档（沿 ADR-0006 诚实降级口径）。

---

## 7. A 级依赖接入点（D10 择优；全部"1 个适配器文件退出"）

> 基线说明：本节列出的适配器/crate 路径均为**规划产物**（文件尚不存在），已按 `check:doc-links`
> 既定出路（`--update`）纳入死链基线；对应文件落地后应再跑 `--update` 收紧回真实验证。

| 依赖                                        | 落点                                                                | 退出答案                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `openid-client` + `jose`（MIT）             | `src/adapters/enterprise/oidcSdkClient.ts` 实现既有 enterprise 端口 | 停更 ⇒ 删该适配器，自研 `oidcClient.ts`（保留为回退资产）即时顶上，0 个调用点改动 |
| `wasmtime`（Apache-2.0+LLVM 例外，Rust 侧） | 新 crate `omni-wasmrt`，经既有 `omni-napi` 手写胶水暴露             | 停更 ⇒ 换 wasmer 或独立 sidecar 进程；IsolationPort 的 wasm 档实现换文件          |
| `croner`（MIT）                             | `src/adapters/daemon/cronerSchedule.ts`                             | 停更 ⇒ 自研 cron 解析（保留）顶上                                                 |

准入手续：`dependency-allowlist.json` 登记（reason/capability/license/**exitPlan**）→ `npm install --save`
→ `npm run check` 阻断验证 → 提交附增益与退出说明。**未办手续前它们不是已引入依赖。**

---

## 8. 门禁与验收增量（新增机械判据清单）

| #   | 判据                                                                                           | Wave | 变异验证（判死能力自证）                       |
| --- | ---------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------- |
| J1  | 信号面端到端：production 遥测 → 提案/密度增量；非 production 行不入                            | A    | 掐断信号源 ⇒ 增量恒 0（红）                    |
| J2  | 无快照不晋升：ledger 不可写 ⇒ 晋升被拒且 reason 注明                                           | A    | 模拟 ledger 故障 ⇒ promote 计数 0（红）        |
| J3  | 台账防篡改：改/删/插三类可检出（沿遥测链判据范式）                                             | A    | 篡改中间条目 ⇒ `verify()` 红                   |
| J4  | 回滚等价：rollback 后注册表与快照逐条深相等                                                    | A    | 回滚后残留新增资产 ⇒ 红（不得静默删除，见 F2） |
| J5  | 级联短路：静态失败 ⇒ verify 调用次数 = 0（注入计数器）                                         | A    | 去短路 ⇒ 计数 >0（红）                         |
| J6  | 绞杀者等价：CapabilityRegistry 上 selectForPrompt→Sparsifier 行为与 SkillRegistry **逐位一致** | B    | 任意差异 ⇒ 红（迁移期间红即禁止合入）          |
| J7  | 未注册类型即拒：schema 缺失的资产在注册口被拒                                                  | B    | 绕过校验 ⇒ 红                                  |
| J8  | 隔离逃逸：`evolved` 档 wasm 内越界访问/超 fuel ⇒ 拒执行且 reason 可读                          | C    | 关 fuel metering ⇒ 红                          |
| J9  | 验签链路：无签名/坏签名/验签后篡改三类全拒                                                     | D    | 各变异 ⇒ 红                                    |

---

## 9. 演进边界（本规格明确不覆盖）

分布式多进程台账（单进程单链；跨进程用资产包分发而非共享链）；跨资产原子事务（用补偿性回滚）；
模型权重训练（GPU RL 沿反泡沫不做）；浏览器/computer use 域（诚实清单既有项，与本规格正交）。

---

## 10. 诚实清单

- 本规格**未实现**：§1–§8 全部为设计产物；唯一"已决策"部分是 Wave A（ADR-0008）。
- §1 契约签名为设计稿，落码时以 ports 纯度门禁与真实调用点为准微调；微调若改变语义须回改本文。
- 人日与判据沿看板口径（可能放大 2×）；Wave E 依赖两关显著，可能永不启动（纪律）。
- 依赖候选的许可证/维护度为 2026-10-04 快照，引入当日以 LICENSE/发布记录为准。
- 与 `ARCHITECTURE_SPEC.md`（现状权威）冲突处以 SPEC 为准，直到对应代码落地并重写 SPEC。
