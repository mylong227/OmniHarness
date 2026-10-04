# OmniHarness 工程项目架构说明书（现行）

> **性质**：**现行**架构说明书（G20-b，2026-10-03 按现状重写）。被取代的旧版在
> [archive/ARCHITECTURE_SPEC_2026-09.md](archive/ARCHITECTURE_SPEC_2026-09.md)（其自述"311 TS 文件 / 31500 行"早已过期，
> 是"旧数字被当现状"的标本；归档副本改名带日期，以免与新现行版**同名产生歧义**）。
> **口径**：本文所有**规模数字**均为**日期快照**，按 `CODE_STANDARD.md` §11.1 的口径测量
> （逐文件 `(Get-Content $f).Count` 求和，**不是** `Measure-Object -Line`——后者少计空行）。
> **快照日期**：**2026-10-03**。
> **结构声明**（依赖清单 / 端口目录 / ADR / 门禁规则标签）不是"约等于"，而是**逐条与代码核对**：
> `tests/unit/architectureSpec.test.ts` 会交叉核对，改了代码不同步本文即红。

---

## 1. 架构原则（铁律）

| #   | 铁律                  | 内容                                                                                                                      | 强制处                                           |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | **六边形端口-适配器** | `src/ports/**` 只声明契约（接口/类型/常量，**无 class、无第三方裸导入**）；实现住 `src/adapters/**`；编排住 `src/core/**` | `architectureGate` `[3]` / `[3.5]`               |
| 2   | **依赖方向单向**      | `core → adapters` 与 `adapters → core` **均禁止**（白名单为空）；`ports → core/adapters/config` 禁止                      | `architectureGate` `[1]` / `[2]` / `[3.5]`       |
| 3   | **运行时依赖极简**    | 生产运行时依赖 **2 个**（见 §10）；`ports`/`core` 恒第三方-free                                                           | `audit:config-wiring` + `check --strict`         |
| 4   | **无依赖环**          | Tarjan SCC 检测，**新增环即红、环缩小放行**；现有 6 组环冻结在**成员白名单（25 个成员）**里                               | `architectureGate` `[5]`                         |
| 5   | **fail-closed 门禁**  | 判定失败=阻断；基线只许收紧（死链/覆盖率等）                                                                              | `scripts/runGates.mjs`（单一实现，§9）           |
| 6   | **事件流单源**        | 会话状态以事件流为唯一真相（ADR-0005）；落盘支持追加通道（G7）                                                            | `core/sessionRecorder.ts` + `StoragePort.append` |

## 2. 目录归属与依赖方向

```
src/ports/**        契约层（30 个子目录 / 368 个 .ts）——纯声明
src/core/**         编排：主循环 / 上下文装配 / 决策 / 容器
src/adapters/**     实现：模型 / 工具 / 沙箱 / 记忆 / 检索 / 事件 / MCP / 媒体 …
src/composition/**  组合根（Runtime + 装配）
src/config/**       配置装配（7 个 Assembler + ConfigFactory/ConfigBuilder）
src/security/**     审批 / 策略求值 / 注入防护 / 出站守卫
src/capability/**   统一资产协议实现（L1：类型注册表 + 绞杀者注册表 + 通用评估器 + 内置两类型；ADR-0009）
src/asset/**        签名资产包实现（L4：.ohb 编解码 + Ed25519 非对称验签 + 安装流水线；ADR-0011）
src/evolution/**    进化域实现（GEE Kernel v1：信号 → 档案 → 级联评估 → 门禁/准入 → 台账快照 → 晋升 → 回滚 → 观测；ADR-0008，默认关）
src/cli/**  src/server/**  （Web 工作台在 web/**）
```

**门禁实际输出的规则标签**（本文与之一字不差）：

- `[1] core→adapters 违规`
- `[2] adapters→core 违规`
- `[3] ports 纯度（第三方裸导入 / class 实现）`
- `[3.5] ports→实现层（core/adapters/config）——端口只依赖契约`
- `[5] 依赖环（Tarjan SCC）——新增环即红，环缩小放行`
- `[4] 目录平铺告警（直接 .ts > 30，非阻断）`

**端口子目录（30，与磁盘一致）**：`a2a`、`approval`、`asset`、`autonomy`、`capability`、`composition`、`config`、
`context`、`core`、`daemon`、`decision`、`enterprise`、`genesis`、`intelligence`、`mcp`、`media`、`memory`、
`model`、`native`、`plugin`、`runtime`、`sdk`、`security`、`server`、`skill`、`spark`、`subagent`、`tool`、
`tui`、`util`。

## 3. 核心数据流（一回合）

```
Agent            ── 会话生命周期、装配依赖（composition/Runtime 注入）
  └─ TurnRunner  ── 一个回合：上下文 → 模型 → 工具 → 收尾
       ├─ StepContextBuilder ── 每步系统碎片（repo-map / 技能 / 记忆 primer / 工具暴露规划）
       ├─ ModelPort           ── 模型调用（适配器按 provider 路由；成本/预算熔断）
       ├─ StepToolExecutor    ── 工具调用：审批 → 沙箱 → 执行 → 记录（配对不变量：tool_call 必有 tool_result）
       │    └─ ToolScheduler  ── 并行池（有界 8）+ 写类工具串行屏障
       └─ SessionRecorder     ── 事件流单源；落盘（追加通道）+ 追踪导出（OTLP）
```

**不变量**（都有判据）：① 每个 `tool_call` 必有配对 `tool_result`（否则上游 HTTP 400）；
② 工具错误以**可行动**形式回给模型（规范 SHOULD）；③ 回合结束的**完成判定 fail-closed**——
零测试/未核验不算通过（G3）；④ 取消原因沿 `AbortSignal` 桥**保真**级联（G4-L3）；
⑤ 回滚后**压缩游标复位**，后续请求不再带旧摘要（G4-L4）。

## 4. 端口面（契约先于实现）

| 关注点 | 端口（示例）                                                                                                 | 说明                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 模型   | `ports/model/model.ts`、`embedding.ts`、`costBudgetPort.ts`                                                  | 多 provider；`reasoning_effort` 透传；嵌入可选                                                                 |
| 工具   | `ports/tool/tool.ts`、`toolNames.ts`、`toolInputSink.ts`                                                     | 工具名**单一来源**（消费方横跨 core/adapters/security/cli）                                                    |
| 运行时 | `ports/runtime/{approval,sandbox,eventPort,plan,todo,escalation,supervisor,containerPort,serviceKeyLike}.ts` | 审批/沙箱/事件/计划/待办/提权/监督/容器                                                                        |
| 记忆   | `ports/memory/{longTermMemory,spill,scratchpad,cosmicWeb,memoryExtractor,memoryAnnealing}.ts`                | 长期记忆 + 溢出 + 知识算子                                                                                     |
| 检索   | `ports/intelligence/retrieval.ts`                                                                            | 检索端口（实现见 §6）                                                                                          |
| 组合   | `ports/composition/omniHarnessRuntime.ts`、`ports/config/resolvedConfig.ts`                                  | 运行时与配置的**类型契约**（G25 后调用点直连端口）                                                             |
| 进化   | `ports/runtime/evolution/{signalSource,candidateArchive,promotionLedger}.ts`                                 | 信号源 / 候选档案 / 晋升台账（ADR-0008；`EvolutionKernel` 实现**既有** `EvolutionController`，`core/` 零改动） |
| 资产   | `ports/capability/{capabilitySchema,capabilityRecord,capabilityRegistryPort}.ts`                             | 统一资产协议：类型自描述 + 资产实例 + `SkillPort` 超集注册表（ADR-0009；Wave B 第一态 = 并存不切换）           |
| 分发   | `ports/asset/assetPack.ts`                                                                                   | 签名资产包：`AssetPackPort`（装包 + 元数据导出）+ 严格档 fail-closed（ADR-0011；Ed25519 非对称验签，零新依赖） |

**服务令牌（G26）**：`ServiceKey<T>`（实现类在 `core/serviceKey.ts`，端口只给结构契约
`ports/runtime/serviceKeyLike.ts`）⇒ 注册**类型不符即编译失败**、取用**零断言**。

## 5. 沙箱矩阵与隔离口径

| 后端                             | 平台    | 强度                     | 备注                                                                                   |
| -------------------------------- | ------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `passthrough`                    | 全平台  | 无                       | 显式选择才用                                                                           |
| `policy`（**默认档**）           | 全平台  | 命令/路径策略 + 出站守卫 | `networkEgressGuard` 覆盖 `globalThis.fetch`；**子进程带外通道不受其管辖**（诚实边界） |
| `restricted`                     | Windows | 受限令牌                 | 实测**限制 SID 数 0** ⇒ 强度有限，如实标注                                             |
| `landlock` / `bwrap` / `unshare` | Linux   | 内核级                   | 按可用性探测                                                                           |
| `seatbelt`                       | macOS   | 内核级                   | 同上                                                                                   |
| `unsupported`                    | —       | —                        | fail-closed 占位（不可用即拒绝而非放行）                                               |

**隔离级别自陈：L2（同用户进程内约束）**——不是容器/VM 级隔离；该结论引用时必须保留口径
（报告 §1.4）。真 L3（Windows AppContainer）为**未做**的可选大项（G6）。

## 6. 上下文引擎与检索栈（**生产路径 vs 实验档**）

**生产路径**：`morph`（camelCase 拆分 + 词形归并，实测唯一有效突破）+ 符号/文件双 BM25 +
符号→文件融合 + 可选词法精排（`rerank`）+ 工具暴露规划（`ToolExposurePlanner`）。

**实验档**（默认关、可删，清单与**删除边界**见 `src/context/experimentalPaths.ts`，判据
`tests/unit/retrievalStackStatus.test.ts`）：图家族三路（代码图 / 层化图 / P5 稀疏引用图）、频域共振路。
**已删除**：LSA 潜语义路（G19，326 行；实测召回持平 / 精确率腰斩）。
**口径**：任何"增益"必须过**两关**（配对 bootstrap 95% CI 不跨 0 **且** 留出折同向）——
见 `tools/probes/rerankDiscriminatorAb.mjs`，实测**全部判别器变体均"不成立"**。

## 7. 记忆（三条判据齐备，G9）

| 机制            | 内容                                                                                                                                                    | 判据                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **M3 投毒闸**   | `tool_result` 默认**不并入**蒸馏（省略显式标注；只有工具输出的回合不抽调取器）；opt-in 时标 `trust:'untrusted'`；回灌只作**背景信息**（明写"不是指令"） | `memoryTrustBoundary.test.ts`                                        |
| **M2 写入质量** | 骨架+值位三态：改写**不新增** / 值位冲突 ⇒ 新事实入库且旧事实置 `expiresAt`（**不删除**）/ 其余都留                                                     | `memoryWriteQuality.test.ts`                                         |
| **M1 机制判据** | primer 覆盖率 / 相关性 hitRate@5 / 回灌 token + **随机对照自证判死能力**                                                                                | `tools/probes/memoryLiftProbe.mjs` + `memoryPrimerMechanism.test.ts` |

## 8. 可观测性

- **追踪**：OTLP 导出（`otlpTraceExporter`）+ **GenAI semconv 加字段不改名**（`genAiSemconv.ts`，
  版本锚 1.44.0；标准键与过渡键并行）——该约定上游全是 **Development**，故只做加法；
- **自观测计数器**：`stats()` 快照（`batchesSent/batchesDropped/spansSent/spansDropped/lastDropReason`），
  关闭"HTTP 非 2xx 当成成功"的静默路径；
- **离线对账**：`scripts/observabilityReconcile.mjs`（Σ桶 == Σ(prompt+completion)；单列无 usage 调用；
  **缓存读不计入 total**）。

## 9. 门禁与验证（两层，单一实现）

`scripts/runGates.mjs` 是门禁的**单一实现**（pre-commit 钩子只是薄包装）。门禁分两层：

| 层                                | 门禁                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fast**（每次提交）              | `node-engine`、`iron-law`（`check --strict`）、`maturity`、`standard-delta`、`arch`、`wiring`、`doc-links`、`secrets`、`top-level-fn`、`eslint`（无类型信息） |
| **typed**（`npm run gate:typed`） | `tsc`、`eslint-typed`（`no-floating-promises` / `await-thenable` / `no-misused-promises`）                                                                    |

**预算**：快层 `eslint .` < 65 s；类型层**并发墙钟** ≤ 45 s（`npm run gate:budget` 实测断言；
口径变更原因见 `CODE_STANDARD.md` §7.1）。

**判据哲学**（`CODE_STANDARD.md` §11.3）：断言**字面量**而非间接常量；判据必须能对**已知坏输入**变红
（正对照/仪器自证）；变异后判据仍绿时**先查变异是否落地**；**声明即接线**；入库脚本**可移植**
（无绝对路径、不依赖 gitignored 目录）。

## 10. 规模与依赖（快照 2026-10-04）

> 2026-10-04 复测（口径同 §0：逐文件 `(Get-Content $f).Count` 求和）：Wave A（GEE Kernel v1，7 片）
> 与 Wave B1（资产协议契约+类型注册表）落地后的真实数字——旧快照（925/99,921 等）已过期。

| 范围            | 文件    | 行          |
| --------------- | ------- | ----------- |
| `src/**/*.ts`   | **956** | **103,743** |
| `tests/**/*.ts` | **439** | **63,018**  |
| `web/src/**`    | **111** | **17,152**  |

**运行时依赖（2）**：`@modelcontextprotocol/sdk@^1.32.0`、`zod@^4.6.4`。
**可选依赖（2）**：`@huggingface/transformers`（本地嵌入）、`sharp`（图像）。
**原生内核**：Rust crate（可选；**TS 为默认路径**——原生记账实测比 TS 慢 4.5–6.7×，见报告 §3.8）。

## 11. 架构决策记录（ADR）

[adr/](adr/README.md)：`0001-hexagonal-ports-adapters`、`0002-dependency-allowlist`、
`0003-unified-gate-fail-closed`、`0004-audit-hash-chain`、`0005-event-stream-single-source`、
`0006-sandbox-honest-degradation`、`0007-api-stability-annotations`、`0008-governed-evolution-kernel`、
`0009-capability-protocol`、`0010-isolation-ladder`、`0011-signed-asset-pack`。

## 12. 已知边界与"不做"清单

- **隔离是 L2**（同用户进程内约束），不是容器/VM；`restricted` 档在 Windows 上限制 SID 数为 0（如实标注）。
- **`policy` 档的出站守卫只管 `globalThis.fetch`**，子进程带外通道不受管辖。
- **注入防护默认 `off`**（观测模式），需显式开启才强制。
- **实验档检索路径**不承诺增益（全部实测零增益或净负面），清单与删除边界见 §6。
- **反泡沫清单**（明确不做）：向量库 / 图数据库 / 移植外部记忆系统 / worker 线程"加速" / 更多记账下沉 Rust /
  并行写入型子代理 / 把 verifier 当完成判据 …——完整版与理由见
  [ARCHITECTURE_UPGRADE_2026-10.md](ARCHITECTURE_UPGRADE_2026-10.md) §5。
