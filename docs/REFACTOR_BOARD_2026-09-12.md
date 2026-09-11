# OmniHarness 重构升级任务看板（2026-09-12 立项）

> 目标：把「零依赖 + 六边形 + 强类型」的架构承诺，从**文档与宣称**落到**可机械校验的门禁与实测数字**上；同时按用户新要求补齐 **TS 严格化 / 全面 OO / 全注释 / 前端 class 规范化**。
> 口径：所有「现状」均来自本日实测（`scripts/auditStandards.mjs` AST 全量扫描 + `scripts/check.mjs --strict` + 子代理代码审计），**不采信任何自我宣称**。
> 纪律：每个任务独立提交，完成即跑四闸门（typecheck / build+test / lint / check），全绿才勾选。
> 状态图例：⬜ 待办 · 🟡 进行中 · ✅ 已完成 · ⏸️ 暂缓（有明确理由）

---

## 0. 决策记录（用户拍板，2026-09-12）

| # | 决策 | 影响 |
| - | ---- | ---- |
| D1 | **文件行数上限 400 → 800**；架构稳定优先于机械拆文件 | `check.mjs` MAX_FILE_LINES 调为 800；原 10 个「超 400 行」文件即时脱违规（最大 stepRunner 526 < 800），重构焦点从「拆文件」转向「解耦/注释/目录归属」 |
| D2 | **前端保留内置 React（vendor UMD），只做 class 规范收口**，不引入 React 依赖、不自研 reconciler | 前端重写面约 13%（~860 行）：根组件 + 内联箭头 + htm 双轨；33 个既有 class 组件保留 |
| D3 | **接受重构，但要求架构稳定**（API 稳定、调用点尽量零改动、每步可回滚） | 采用既有已验证范式：抽协作者 + 原文件留门面/桶、导出路径不变 |
| D4 | **零成本优先**：不引入需要付费/联网的验证手段进主门禁 | eval 门禁继续用 SWE replay 零 key 模式；官方基准另挂 |

---

## 1. 现状基线（2026-09-12 实测）

### 1.1 规范度量（`scripts/auditStandards.mjs`，392 个 src `*.ts` / 33748 行）

| 指标 | 现状 | 目标 | 判定 |
| ---- | ---- | ---- | ---- |
| `var` 用法 | **0** | 0 | ✅ |
| `any` 用法 | **0** | 0 | ✅ |
| `static` 用量 | **20**（11 常量 + 9 工厂，全合法） | ≤20 | ✅ |
| 类成员缺显式访问修饰符 | **20 / 2105**（热区豁免残留） | 0 | 🟡 |
| 公开成员缺 JSDoc | **281 / 910（30.9%）** | 0 | ⬜ 最大缺口 |
| 顶层函数 | 369（导出 249；**缺 JSDoc 2 / 缺返回类型 2**） | 0 / 0 | 🟡 |
| 上帝类（>500 行或 >25 方法） | **1**（`core/stepRunner.ts` 526 行 / 22 方法，热区） | 0 | 🟡 |
| 文件名 ≠ 主类名 | **1**（`ports/model` 端口豁免，非违规） | 1 | ✅ |
| 单文件 ≥3 导出类 | **0** | 0 | ✅ |
| 超过 800 行的文件 | **0**（上限放宽后） | 0 | ✅ |

### 1.2 注释细粒度覆盖（子代理 AST 实测）

| 维度 | 覆盖 | 目标 |
| ---- | ---- | ---- |
| 类 JSDoc | 89.8% | 100% |
| 顶层函数 JSDoc | 99.2% | 100% |
| 接口 / 类型 JSDoc | 97.3% / 96.7% | 100% |
| 类方法 JSDoc | 73.9% | 100% |
| **类字段注释** | **24.2%** | ≥80% |
| **有参方法的 `@param`** | **11.1%** | ≥80% |
| **有返回类型方法的 `@returns`** | **9.0%** | ≥80% |

> 缺口集中在「端口实现型适配器」的 CRUD 方法（`adapters/memory/*`、`adapters/kv/*`、`adapters/vault/*`），见 `auditStandards --jsdoc` 的 Top 40。

### 1.3 架构与耦合（子代理审计）

| 问题 | 实测证据 | 严重度 |
| ---- | -------- | ------ |
| **core ↔ adapters 双向依赖（分层名存实亡）** | core→adapters **8 处**：`core/runtime.ts:19/20/21`、`core/stepRunner.ts:28`、`core/toolGate.ts:4`、`core/checkpointManager.ts:5`、`core/turnRunner.ts:7`；adapters→core **9 处**：`adapters/tool/{askUserTool,planWriteTool,todoWriteTool,planPresentTool,runGoalTool,checkpointTool,rollbackTool}.ts`、`adapters/diff/turnDiffHooks.ts:4-5` | 🔴 最高 |
| **隐式单例 18 个**（模块级 `export const x = new Y()`） | `util/logger`、`core/eventFactory`、`context/repoMapContextEngine`、`config/configFile`、`config/profileLoader`、`skill/skillRegistry`、`mcp/*`（协议/连接/传输/映射 4 个）、`server/jsonRpc`、`adapters/approval/guardianPrompt`、`adapters/sandbox/dangerousCommands`、`adapters/model/sseParser`、`worker/dshWorker`、`subagent/subagentRuntimeFactory` 等 | 🟠 高 |
| **目录平铺** | `adapters/tool/` **38 个 .ts 平铺**（>30 阈值）；`adapters` 121、`ports` 42、`server` 29、`cli` 22、`context` 21 | 🟠 高 |
| **同名前缀散落多目录** | `spark`（config/ + spark/）、`spill`（ports/ + context/ + adapters/ + adapters/tool/）、`lsp`（lsp/ + adapters/lsp/ + adapters/tool/ + ports/）、`sandbox`（adapters/ + plugin/ + ports/）、`memory`（adapters/ + adapters/tool/ + ports/） | 🟡 中 |
| 端口纯度受损 | `ports/model.ts` 混入 `ModelCallError`(L125) / `BudgetExceededError`(L151) 两个实现类 | 🟡 中 |
| 巨型函数（>80 行） | **门禁实测 2 处**：`config/configError.ts:118`(88)、`context/projectInstructions.ts:180`(90)；**子代理启发式另报 5 处**（`cli/execCli.ts:31` 128、`spark/sparkController.ts:165` 113、`cli/cliServerCmds.ts:294` 113、`core/turnRunner.ts:62` 95、`server/appServer.ts:212` 86）——需人工复核是真超限还是启发式误报 | 🟡 中 |
| 类型逃逸 | 非空断言 `!` 约 **181 处 / 40 文件**；`as unknown as` **13 处 / 10 文件** | 🟡 中 |
| 公共 API 面过大 | `src/index.ts` 单文件 **71 个导出**（fan-in 最高 `ports/tool` 61、`ports/model` 46） | 🟡 中 |

### 1.4 门禁与 CI

- `scripts/check.mjs --strict` 阻断项：**立项时 13 处 → P0.1 后 3 处**（10 个 >400 行文件经 D1 放宽清零；剩余 = 2 个 >80 行函数 + 1 项依赖体积：`@huggingface/transformers` node_modules 2.2 GB > 200 MB 预算）。
- CI（`.github/workflows/ci.yml`，8 job：gate/web/test/security/rust/e2e/wasm/eval）**已存在**；但 `auditStandards.mjs` **未接入 CI**，注释/架构约束**零门禁**。
- ESLint 已禁 `no-var` / `no-explicit-any` / `explicit-member-accessibility`；**无 jsdoc 规则**。

### 1.5 前端现状（web/，69 文件 / 6794 行）

| 项 | 现状 |
| -- | ---- |
| 技术栈 | 无 npm React 依赖；`web/vendor/react.production.min.js` + `react-dom` + `htm` UMD 全局；`web/tsconfig.json` `jsx:"react"`、`jsxFactory: React.createElement`；自造 `react-shim.d.ts`(173 行) |
| 组件写法 | **33 个 class 组件**（`extends React.Component`/`AppComponent`）——已是 class 范式，无需从零改造 |
| 唯一函数组件 | **根 `App.ts`（739 行 / 68 个 hook / 21 个 useState）** |
| 内联问题 | render 内联匿名箭头 **80+ 处**（Composer 33、SessionPanel 23、GraphTab 22、ChangesTab 19…）；`App.ts:680/690/730` htm 内联箭头 |
| 双轨渲染 | TSX（组件）+ htm `` html`` ``（`App.ts` 13 处、`format.ts` 39 处） |
| 状态 | 无全局可变 store；`Context` 注入 + 服务经 `useMemo` 一次性 new（`App.ts:42-44`）；`EventStream`/`ToastService` 用回调而非 EventTarget |
| 后端接口 | `POST /rpc` JSON-RPC 2.0（`ApiClient.ts:46-58`）、`GET /events` SSE、`GET /metrics` |
| 测试 | 3 个 `.mjs` / 318 行，**只测纯逻辑**（models/uiModels/textUtils），**组件层 0 覆盖** |
| 遗留 | `index-classic.html` 1282 行 vanilla 旧版（77 处 innerHTML / 6 处内联 on*），与新版双实现并存 |

---

## 2. 目标架构（重构后应达到的形态）

### 2.1 依赖方向（唯一铁律，将被门禁强制）

```
        ┌──────────────── 组合根（唯一 new 具体实现的地方）────────────────┐
        │  config/ConfigFactory + core/Container + ServiceKeys            │
        └───────────────┬──────────────────────────────┬─────────────────┘
                        │ 装配注入                      │ 装配注入
                        ▼                              ▼
   src/ports/**  ◄── 依赖 ──  src/core/**        src/adapters/**  ──► 实现 ports
   （纯接口 + 纯类型）        （只依赖端口）         （唯一允许 IO / 第三方）
        ▲                                              │
        └──────────────── 禁止 core → adapters 直连 ────┘
```

**强制规则（新门禁）**：
1. `src/ports/**` 只含接口与纯类型（当前 `ports/model.ts` 的两个 Error 类须迁出）。
2. `src/core/**` **禁止 import `adapters/**`**（现状 8 处违规）。
3. `src/adapters/**` **禁止 import `core/**` 的具体实现/单例**（现状 9 处违规）；跨域协作一律经端口。
4. 具体实现的 `new` 只允许出现在组合根（`config/**`、`core/runtime.ts` 的装配函数）与测试中。
5. 模块级 `export const x = new Y()` 仅允许**无状态/纯常量**用途；有状态者必须从组合根显式装配注入。

### 2.2 目录与归属规范

- **一域一目录族**：一个领域 = `ports/<域>.ts` + `adapters/<域>/**` + 该域工具（`adapters/<域>/tool/*Tool.ts`），禁止同名域散落 3 个以上顶层目录。
- **目录规模上限**：单目录文件数 **≤30**（`adapters/tool` 38 需按域拆分子目录）。
- **一文件一类**（已达成）：文件名 camelCase = 主类名 PascalCase（`ports/**` 接口文件豁免）。
- **每目录职责单一**：子目录按「域」划分，不按「技术角色」无限细分；新增目录须在 `docs/ARCHITECTURE_SPEC.md` 的归属表中登记。

### 2.3 写法规范（沿用 `docs/CODE_STANDARD.md`，本次补齐细则）

| 项 | 要求 | 门禁化 |
| -- | ---- | ------ |
| 语言 | TS + ESM + strict；禁 `var`/`any`/`@ts-ignore` | ✅ ESLint 已强制 |
| 访问权限 | 每成员显式 `public`/`private`/`protected` | ✅ ESLint（热区豁免待撤） |
| 面向对象 | 有状态/内聚操作收敛为类（见 `OOP_REFACTOR_BACKEND_PLAN.md` 判据）；**纯函数不得为 OO 而 OO** | 人工评审 |
| 注释（新增强制） | 每个**类**（作用）、**字段**、**方法**（职责）、**入参 `@param`**、**返回值 `@returns`** 必须有 JSDoc | ⬜ 待建门禁 |
| 单例 | 慎用；有状态者从组合根注入；模块级 `new` 须登记理由 | ⬜ 待建门禁 |
| static | 仅常量命名空间与 smart constructor | ✅ 已收敛至 20 处 |
| 无硬编码路径 | 一律 `CONFIG` + 环境变量派生 | ✅ 既有铁律 |
| 前端（新增） | 组件一律 class（`extends AppComponent`）；**render 内禁止内联匿名函数**，一律绑定实例方法；生命周期用 `componentDidMount/DidUpdate/WillUnmount`；实例字段替代 `useRef`；状态用 `this.state` + `setState` | ⬜ 待建门禁 |

---

## 3. 任务看板

### P0 门禁与度量基座（先立尺，再动刀）

| ID | 任务 | 现状证据 | 动作 | 验收 | 状态 |
| -- | ---- | -------- | ---- | ---- | ---- |
| P0.1 | 文件上限放宽至 800 | `check.mjs:26` `MAX_FILE_LINES=400` | 改 800；函数上限 80 保留；同步 `CODE_STANDARD.md` 规则行 | ✅ **实测 13 处 → 3 处**（10 个文件行数违规清零；剩 2 函数 + 1 依赖体积） | ✅ |
| P0.2 | 扩展 `auditStandards.mjs` 度量 | 现仅测 JSDoc 有无，不测 `@param/@returns`/字段注释/分层越界 | 新增 4 类度量：`@param`/`@returns` 覆盖、字段注释覆盖、core→adapters 违规、模块级 `new` 清单 | 脚本输出含以上 4 项数字 | ⬜ |
| P0.3 | 审计入 CI（报告级起步） | `auditStandards` 仅手工跑，CI 无 standards job | CI 加 `standards` job：输出度量并写 job summary；**先不阻断** | CI 可见趋势数字 | ⬜ |
| P0.4 | 架构约束门禁（阻断级） | 无任何分层方向校验 | 新增 `scripts/architectureGate.mjs`（零依赖 AST/正则）：禁 core→adapters、禁 ports 导入实现、单目录 >30 文件告警 | 门禁跑通；当前 17 处违规列为白名单递减 | ⬜ |

### P1 分层解耦（最高价值 · 架构稳定核心）

| ID | 任务 | 现状证据 | 动作 | 验收 | 状态 |
| -- | ---- | -------- | ---- | ---- | ---- |
| P1.1 | 消 core→adapters 反向依赖 | 8 处：`core/runtime.ts:19-21`、`stepRunner.ts:28`、`toolGate.ts:4`、`checkpointManager.ts:5`、`turnRunner.ts:7` | 改为**端口注入 + 组合根装配**（`runtime.ts` 降级为装配函数，不 import 具体适配器） | P0.4 门禁 core→adapters = 0；单测全绿 | ⬜ |
| P1.2 | 消 adapters→core 反向依赖 | 9 处工具/钩子依赖 `core/eventFactory` 单例等 | 事件工厂改为**端口（EventFactoryPort）**注入；工具类构造注入 | 门禁 adapters→core 具体实现 = 0；工具单测绿 | ⬜ |
| P1.3 | `ports/model.ts` 端口纯化 | `ModelCallError`(L125)、`BudgetExceededError`(L151) 为实现类 | 迁出为独立文件（`modelCallError.ts` 等）或改纯 interface + 工厂 | ports 层零 class 实现 | ⬜ |
| P1.4 | 依赖方向门禁升阻断 | 依赖 P0.4 | 白名单清零后升级为 exit 1 | CI 阻断生效 | ⬜ |

### P2 单例治理（消除隐式全局状态）

| ID | 任务 | 现状证据 | 动作 | 验收 | 状态 |
| -- | ---- | -------- | ---- | ---- | ---- |
| P2.1 | 单例登记与分类 | 18 个模块级 `export const x = new Y()` | 建 `docs/SINGLETON_REGISTRY.md`：逐个标注「无状态可留 / 有状态须注入 / 组合根装配」+ 理由 | 18 个全部有明确归类 | ⬜ |
| P2.2 | 有状态单例收敛 | `repoMapContextEngine`、`configFile`、`skillRegistry`、`mcpConnector`、`subagentRuntimeFactory`、`dshWorker` 等 | 改为组合根装配 + 构造注入；调用点尽量零改动（留门面） | 模块级有状态 `new` = 0；单测绿 | ⬜ |
| P2.3 | 事件工厂去单例化 | `core/eventFactory.ts:137` 被 9 处适配器反向依赖 | 与 P1.2 合并实施（端口注入） | 同上 | ⬜ |

### P3 目录与归属重组（可移植 / 低耦合）

| ID | 任务 | 现状证据 | 动作 | 验收 | 状态 |
| -- | ---- | -------- | ---- | ---- | ---- |
| P3.1 | `adapters/tool` 按域拆分 | 38 个 .ts 平铺 | 拆为 `tool/fs/`、`tool/shell/`、`tool/git/`、`tool/web/`、`tool/lsp/`、`tool/plan/`、`tool/memory/` 等；**原路径留桶再导出**，调用点零改动 | 单目录 ≤30；门禁通过；单测绿 | ⬜ |
| P3.2 | 同名前缀域收敛 | `spark`/`spill`/`lsp`/`sandbox`/`memory` 各散落 3+ 目录 | 每域收敛为 `ports/<域>.ts` + `adapters/<域>/`；保留导出路径兼容层 | 5 个域归属唯一 | ⬜ |
| P3.3 | 目录归属表文档化 | `ARCHITECTURE_SPEC.md` 无完整目录规则 | 增补「目录归属表 + 新增目录准入规则 + 单目录文件上限」 | 文档与门禁一致 | ⬜ |

### P4 注释与可读性（用户新增强制要求）

| ID | 任务 | 现状证据 | 动作 | 验收 | 状态 |
| -- | ---- | -------- | ---- | ---- | ---- |
| P4.1 | 公开成员 JSDoc 清零 | **281/910 缺**；Top：`resonantFieldEngine`(12)、`cosmicWebMemoryEngine`(9)、`ed25519AgentIdentity`(8)、`jsonFileKv/memoryKv/sqliteKv`(各 8) | 按 `auditStandards --jsdoc` 排名分批补，先适配器 CRUD 族 | 缺 JSDoc = 0 | ⬜ |
| P4.2 | `@param` / `@returns` 补齐 | **11.1% / 9.0%**（约 1080 个方法） | 有参/有返回方法强制标注；分模块批次提交 | 覆盖 ≥80% 起步，终值 100% | ⬜ |
| P4.3 | 类字段注释补齐 | **24.2%**（439/579 缺） | 每个实例字段一行职责说明 | ≥80% → 100% | ⬜ |
| P4.4 | 注释门禁化 | 无 jsdoc 规则；`auditStandards` 未入 CI | 零依赖优先：在 `check.mjs` 增「公开成员必须有 JSDoc」阻断项（可先报告级） | 新增公开成员缺注释即红 | ⬜ |
| P4.5 | 巨型函数拆分 | **门禁阻断 2 处**：`configError.ts:118`(88 行)、`projectInstructions.ts:180`(90 行)；子代理启发式另报 5 处待复核（`execCli:31`、`sparkController:165`、`cliServerCmds:294`、`turnRunner:62`、`appServer:212`） | 前 2 处按职责缝拆；对另 5 处先复核（check.mjs 启发式与子代理口径不一致，须以门禁口径为准并补齐盲区） | `check --strict` 函数违规 = 0 | ⬜ |
| P4.6 | 类型逃逸收敛 | 非空断言 ~181 处 / `as unknown as` 13 处 | 优先消除 `as unknown as`（13 处）；非空断言按模块逐步以窄化/守卫替代 | `as unknown as` = 0；非空断言减半 | ⬜ |

### P5 前端 class 规范收口（D2：保留内置 React）

| ID | 任务 | 现状证据 | 动作 | 验收 | 状态 |
| -- | ---- | -------- | ---- | ---- | ---- |
| P5.1 | 根组件 `App.ts` 转 class | 739 行 / 68 hook / 21 useState | 插桩：hook → `this.state` + 箭头方法；`useEffect` → 生命周期；SSE 接线挂 `componentDidMount` | 全库 hook 数 = 0（除第三方 shim）；UI 功能不回退 | ⬜ |
| P5.2 | 消灭 render 内联匿名箭头 | 80+ 处（Composer 33、SessionPanel 23、GraphTab 22、ChangesTab 19…） | 改为实例箭头方法或参数化方法（`onClick={this.handleSave}` / `onClick={() => this.handlePick(id)}` 至少提为方法） | 内联匿名箭头 = 0（可加 ESLint 自定义/正则门禁） | ⬜ |
| P5.3 | 去 htm 双轨 | `App.ts` 13 处 + `format.ts` 39 处 `` html`` `` | 统一改 TSX（`React.createElement` 由 jsx 编译产出） | 全库 htm 用法 = 0 | ⬜ |
| P5.4 | 基座 `AppComponent` 固化 | `web/src/ui/base/AppComponent.tsx` 仅 53 行 | 明确 props/state/setState/生命周期契约，作为唯一组件基类文档化 | 33 个组件统一 `extends AppComponent` | ⬜ |
| P5.5 | 组件层测试（零依赖 DOM 桩） | 组件测试 **0**；仅 3 个纯逻辑测试 | 自研最小 DOM 桩（~100 行）+ 挂载/交互断言，先覆盖 P5.1/P5.2 改动面 | 关键组件有挂载测试；`web:test` 覆盖渲染层 | ⬜ |
| P5.6 | 归档 `index-classic.html` | 1282 行 vanilla 双实现（77 innerHTML） | 移入 `web/legacy/` 或删除（确认无入口引用） | 主目录无双实现 | ⬜ |

### P6 封装与热区收口（承接既有 Phase 7）

| ID | 任务 | 现状证据 | 动作 | 验收 | 状态 |
| -- | ---- | -------- | ---- | ---- | ---- |
| P6.1 | 热区豁免清算 | 20 处隐式 public（`stepRunner`/`turnRunner`/`adapters/live`/`toolInputSink` 豁免块） | 撤 ESLint 覆盖块，补齐显式修饰符 | 隐式 public = 0 | ⬜ |
| P6.2 | 封装收紧（Phase 7） | Phase 1 只做了「显式化」，未判 private/protected | 识别本应非公开的成员并收紧（人工判断 + 单测护栏） | 分模块推进，逐批准入 | ⬜ |
| P6.3 | `stepRunner` 上帝类收口 | 526 行 / 22 方法，唯一剩余上帝类 | 解除热区标记后按职责缝拆协作者（保持导出与调用零改动） | 上帝类 = 0 | ⬜ |

### P7 技术栈升级（调研落地）

| ID | 任务 | 依据 | 收益 | 风险 / 前置 | 状态 |
| -- | ---- | ---- | ---- | ----------- | ---- |
| P7.1 | tsconfig 加严（渐进） | 现状未开 `exactOptionalPropertyTypes`/`noUnusedLocals`/`noUnusedParameters`/`noImplicitReturns` | 消除隐式 undefined 与死代码 | `exactOptionalPropertyTypes` 连带修改面大，最后开 | ⬜ |
| P7.2 | `verbatimModuleSyntax` + `import type` | TS 5.x 强约定，为 TS 7.0（Go 编译器，strict-by-default）铺路 | 类型导入可擦除、构建更快、语义更明确 | 403 interface + 196 type 导入需改 | ⬜ |
| P7.3 | target ES2022 → ES2025，评估 Node 引擎升级 | 平台已到 Node 26；本项目 engines `>=22.18.0` | 拿到 `using`/迭代器助手/`Promise.try` 等 | 需确认 node:sqlite 兼容面（既有决策曾为 Node 20 兼容而弃 FTS5） | ⬜ |
| P7.4 | 开发期免构建（Node 原生 type-stripping） | Node 24+ 默认剥离、26 稳定；本项目大量**构造器参数属性**（不支持剥离） | 开发/脚本启动免除 tsc 等待，提效 | 前置：消除参数属性 + enum；仅用于 dev/scripts，CI 仍需 tsc 类型检查 | ⏸️ 待评估 |
| P7.5 | 资源管理用 `using` / `Symbol.dispose` | 已有多处 `close()`（`adapters/kv/*`、`adapters/vault/*`、transport） | 消除泄漏与 try/finally 样板 | 与 P7.3 绑定（需 ES2025 目标） | ⬜ |
| P7.6 | 平台内置替身清理零散工具 | `fs.glob`、`util.styleText`、`--env-file`、`node --run` | 减少脚本层胶水与 npm 脚本开销 | 低风险 | ⬜ |

### P8 可移植性与公共面

| ID | 任务 | 现状证据 | 动作 | 验收 | 状态 |
| -- | ---- | -------- | ---- | ---- | ---- |
| P8.1 | 域垂直切片模板 | 新域需手抄 ports+adapter+tool 三件套 | 固化模板与检查清单（文档 + 脚手架脚本） | 新域按模板 30 分钟内起 | ⬜ |
| P8.2 | 公共 API 面收敛 | `src/index.ts` 71 导出，单文件 479 行 | 按域拆分出口 + 子路径导出（`./beta` 已有先例）；`api:check` 强化 | 出口分类清晰，可移植子集可单独 import | ⬜ |
| P8.3 | 端口 SDK 化（外部可编程） | 端口已纯化但无对外契约文档 | 产出 `docs/PORTS_CONTRACT.md`（每端口职责/契约/实现清单） | 第三方可实现端口接入 | ⬜ |

---

## 4. 度量趋势表（每阶段完成后回填）

| 度量 | 起点(09-12) | P0 后 | P1 后 | P2 后 | P3 后 | P4 后 | P5 后 | 目标 |
| ---- | ---------- | ----- | ----- | ----- | ----- | ----- | ----- | ---- |
| `check --strict` 阻断项 | 13 | **3** | | | | | | 0 |
| core→adapters 违规 | 8 | | | | | | | 0 |
| adapters→core 违规 | 9 | | | | | | | 0 |
| 模块级有状态 `new` | 18 | | | | | | | 0 |
| 公开成员缺 JSDoc | 281 / 910 | | | | | | | 0 |
| `@param` 覆盖 | 11.1% | | | | | | | 100% |
| `@returns` 覆盖 | 9.0% | | | | | | | 100% |
| 字段注释覆盖 | 24.2% | | | | | | | ≥80% |
| 单目录最大文件数 | 38 | | | | | | | ≤30 |
| 超 80 行函数 | 2（门禁口径） | | | | | | | 0 |
| 上帝类 | 1 | | | | | | | 0 |
| 前端 hook 数 | 68 | | | | | | | 0 |
| 前端内联匿名箭头 | 80+ | | | | | | | 0 |
| 隐式 public | 20 | | | | | | | 0 |

---

## 5. 进度跟踪机制

1. **每任务独立提交**，提交信息带任务 ID（如 `refactor(p1.1): 消 core→adapters 反向依赖`），本看板勾选 ✅ 并填 commit 短哈希。
2. **每阶段收口**跑全门禁：`npm run check -- --strict` + `npm run typecheck` + `npm test` + `npm run test:integration` + `npm run lint` + `npm run eval:ci`；全绿才推进下一阶段。
3. **度量口径唯一来源**：`node scripts/auditStandards.mjs --jsdoc`（扩展后含 P0.2 的四类新度量），数字进 §4 趋势表。
4. **架构约束机械可证**：P0.4 门禁上线后，core→adapters / ports 纯度 / 目录规模由脚本判定，不靠人工评审。
5. **不追求一次性达成**：允许白名单递减（先冻结现状、新增即红、存量按批清偿）。

---

## 6. 明确不做（防止过度重构）

- ❌ 不把纯函数强行类化（`OOP_REFACTOR_BACKEND_PLAN.md` §0 判据：纯函数保持函数）。
- ❌ 不引入 React 依赖、不自研虚拟 DOM 替换（D2）；前端只做 class 规范收口。
- ❌ 不为拆而拆：800 行内的文件若职责单一，保留（D1）。
- ❌ 不引入任何需要付费/联网的验证进主门禁（D4）。
- ❌ 不做一次性的目录大搬家：移动一律保留原导出路径桶，调用点零改动，可回滚（D3）。
- ⏸️ `stepRunner`/`turnRunner`/`adapters/live` 热区在并行会话活跃期间不动，待 P6.3 统一收口。

---

## 7. 与其他文档的关系

| 文档 | 关系 |
| ---- | ---- |
| `docs/CODE_STANDARD.md` | 写法规范正典；本看板 P4/P5 为其「注释强制 + 前端细则」的补充与门禁化 |
| `docs/CODE_STANDARD_REFACTOR_PLAN.md` | 八条规范战役（Phase 0-7）；**Phase 2（JSDoc）与 Phase 7（封装收紧）未完成**，由本看板 P4、P6 承接 |
| `docs/OOP_REFACTOR_BACKEND_PLAN.md` | 顶层函数 OO 收敛清单；Top-18 已完成，后续按判据增量 |
| `docs/ARCHITECTURE_SPEC.md` | 目标架构说明书；P3.3 增补目录归属表 |
| `docs/UPGRADE_BOARD_2026-09-12.md` | 能力升级（U1-U7）看板；本看板是**工程架构与写法**侧，两者并行 |
| `docs/adr/*` | 架构决策记录；本看板新增门禁应补 ADR（依赖方向门禁、注释门禁） |
