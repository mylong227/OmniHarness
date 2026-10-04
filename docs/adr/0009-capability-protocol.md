# 0009 统一资产协议（CapabilitySchema / CapabilityRegistry 绞杀者迁移）

- 日期：2026-10-04
- 状态：已接受（实施规格见 [../EVOLVIX_SPEC_2026-10.md](../EVOLVIX_SPEC_2026-10.md) §1–§3；波浪路线见 [../ARCHITECTURE_TARGET_2026-10.md](../ARCHITECTURE_TARGET_2026-10.md) §7）
- 前置：Wave A（[ADR-0008](./0008-governed-evolution-kernel.md)）全绿——台账/回滚已在 `src/evolution/`

## 背景

Wave A 把进化闭环的**编排**与**治理**补齐了（`EvolutionKernel` + `PromotionLedgerPort`），但「可进化对象」
本身仍只有一种：`Skill`。`SkillRegistry` 是技能专用容器（`Map<string, Skill>` + BM25 选择 + 燧-1 组合），
任何新资产类型（工作流模板 / 洞察 / 算子 / 任务集）要么硬塞进 `Skill` 的字段里，要么另起一个平行注册表——
两条路都会把「治理语义」（信任档、隔离档、台账、门禁基准）复制 N 份，很快漂移。

目标态（Evolvix-Ω L1）要求：**一切可进化对象实现同一份自描述协议**，`Skill` 只是**第一个实例**。

## 决策

1. **资产类型自描述**：新增 `CapabilitySchema`（`ports/capability/capabilitySchema.ts`）：
   类型键 + 版本 + `validate(asset)`（fail-closed 结构校验）+ `evalContract(ctx)`（**度量由类型作者声明**，
   Ω-4）+ 默认信任档/隔离档 + 台账语义。类型注册表 `CapabilitySchemaRegistryPort` 管理它们。
2. **注册表是 `SkillPort` 的严格超集**：`CapabilityRegistryPort` = `SkillPort` 全量 + `put(record)` /
   `recordOf(name)` / `recordsOfKind(kind)` / `setGovernance(name, patch)`。资产实例承载
   `lineage`（溯源）/ `fitness`（最近评估，只增不改）/ `governance`（信任档、隔离档、状态、台账 seq）。
3. **绞杀者迁移，第一态 = 并存不切换**：`CapabilityRegistry` **内部持有既有 `SkillRegistry`**，
   `SkillPort` 全量成员一律**委托**给它，不复制一份实现。生产注入路径
   （`SessionInjector.injectSkills`：`rankForPrompt → SkillSparsifier → render`）**本次不动**；
   迁移只做两件事：① 让注册表**可用**且**行为逐位等价**（判据 J6）；② 把该路径的依赖从**实现类**收窄为
   **端口**（`SkillSelectionPort`），使「切换」在类型上成为可能而非需要改 core。
   **为什么不一刀切**：注册表是注入路径的唯一状态源，大爆炸式重写违反 S1/S2，本仓历史上从未幸存；
   等价判据在迁移期间**红即禁止合入**。
4. **注册口 fail-closed（J7）**：`put(record)` 必须用所属 `schemaKind` 的 `validate` 把关；
   **未注册类型即拒**、结构非法即拒——绝不「先收下再想办法」。
5. **治理变更必须留台账**：`setGovernance` 是状态变更，必须经注入的 `PromotionLedgerPort` 入链并回写
   `ledgerSeq`；**无台账即拒绝变更**（沿 ADR-0008「无快照不晋升」的同一纪律：无账不生效）。
6. **信任档/隔离档只可收紧**：变更补丁只能朝更严方向走（档位有全序）；放宽必须换一条显式配置路径，
   不得由资产自身或补丁悄悄完成。
7. **端口层零实现、零第三方**：`ports/capability/**` 只放接口与联合类型（`trustTier` / `isolationLevel`
   两个字符串联合），与既有 `ports/**` 同纪律（`arch:gate` [3]/[3.5] 强制）。
8. **默认关、零破坏**：本波不改变任何既有默认行为；CLI/配置只在显式开启时可见新面。

## 后果

- 正面：新资产类型只需**一个 schema 文件 + 一条注册调用**，Kernel/治理层零改动（上限轴 1 打开）；
  台账/门禁基准/信任档从「技能专用」升格为「协议级」，后续 Wave C/D 的隔离与分发直接挂在协议上。
- 负面：资产实例多一层 `CapabilityRecord` 包装（`asset: unknown` + schema 把关），
  取值需要 `recordOf()` 而不是直接拿 `Skill`；短期内注册表有两份状态视图（技能表 + 记录表），
  必须靠「委托同一 `SkillRegistry`」保证不漂移（判据 J6 钉住）。
- 边界（沿反泡沫清单）：不做跨资产类型全局事务（台账分链 + 补偿性回滚）；
  不做注册表的一次性重写；`CapabilityRecord.asset` 保持 `unknown`（由 schema 把关），不引入运行时反射。

## 替代方案

- **把新类型塞进 `Skill` 的可选字段**——拒绝：`Skill` 是注入上下文与莫尔组合的领域对象，
  塞进工作流模板/算子会让每个既有消费点都要忍受无关字段，且 `validate` 无处安放。
- **为每种类型各起一个注册表**——拒绝：治理语义（台账/门禁基准/信任档/隔离档）会被复制 N 份，
  正是 ADR-0008 已经吃过一次的「六环散件」形态。
- **一次性把 `SkillRegistry` 重写为 `CapabilityRegistry`**——拒绝：注入路径是生产关键路径，
  大爆炸违反 S1/S2；本仓选择绞杀者 + 逐位等价判据（J6）。
- **用 JSON Schema / zod 做 `validate`**——拒绝：`ports/**` 恒第三方-free（Ω-0），
  且类型作者本就该声明自己的判据（Ω-4）；zod 若将来必要，只能落在适配层并把结果喂给 schema。
