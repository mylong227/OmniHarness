# 接口层重构队列（INTERFACE_REFACTOR_QUEUE）

> ⚠️ **已归档（2026-10-03，G20 文档瘦身）**：本文是**历史记录**——其中的文件数、测试数、召回率等
> 数字与结论**均不再代表现状**，请勿据此判断当前实现。现行唯一事实源见 [PROJECT_BOARD.md](../../PROJECT_BOARD.md)，
> 现行纪律见 [CODE_STANDARD.md](../../CODE_STANDARD.md)；归档索引见 [archive/README.md](../README.md)。

> **目标**：把 `export interface X {}` / `export type X = …` 从「散落在实现文件里」收敛为**基础模块**——
> 集中在唯一接口层 `src/ports/**`，**一接口一文件**，**单向依赖、不成环**。
>
> **器械**：`scripts/auditInterfaces.mjs`（审计 + 队列生成）、`scripts/architectureGate.mjs` 规则 `[5]`（依赖环门禁）。
> 两者口径必须一致（历史踩坑见 §3 R6）。
>
> **执行方式**：**一个文件一个文件**推进；单个文件改完即跑 §5 的验收命令，**全绿才动下一个文件**；
> 过程中不碰 §7 列出的「并行会话占用文件」，后续再回头处理。

## 0. 机器复现（动手前先跑这三条）

```bash
node scripts/auditInterfaces.mjs         # 摘要 + 跨模块接口 TOP（接口散落现状）
node scripts/auditInterfaces.mjs --queue # 全量逐文件队列（Markdown，本文件 §4 的表就由它产出）
node scripts/architectureGate.mjs        # 架构门禁：[5] 节即依赖环现状
```

队列是**生成物**，不要手抄进本文件——永远以 `--queue` 的输出为准。

## 1. 判定口径（三条，全部可机械判定）

| #   | 口径           | 判据                                                    | 含义                                                                     |
| --- | -------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | **跨模块接口** | 该接口被「声明所在 `src` 二级目录之外」的文件引用       | 只能靠「实现文件 → 实现文件」的 import 才能共享 ⇒ **必须**升格为基础模块 |
| 2   | **混装文件**   | 同一文件既有 `interface`/`type` 又有 `class`/`function` | 契约与实现同居 = 职责缝                                                  |
| 3   | **依赖环**     | 模块 import 图的强连通分量（Tarjan）                    | 见下方「值边 / 类型边」判据                                              |

**值边 / 类型边的判据（不可一刀切）**：

- **值位置**（编译后保留，产生**运行时**依赖）：`new X()`、调用 `X()`、装饰器 `@X`、**`extends X`**；
- **类型位置**（编译后被 TS 擦除，只产生**契约层**耦合）：`x: X`、`implements X`、`typeof X`、`as X`、泛型实参。
- 特别注意 **`extends` 算值位置、`implements` 算类型位置**——`ts.isTypeNode()` 对二者都返回 `true`，
  直接用它会**误判 `extends` 为可擦除**，从而漏报真实运行时环。`scripts/auditInterfaces.mjs` 已对此显式分支。

**「域」的定义**：`src/<域>/…` 的 `<域>` 即二级目录（例如 `src/ports/runtime/` 下的文件域是 `ports`，
`src/adapters/tool/` 下的文件域是 `adapters`）。
「跨模块」= 声明文件与引用文件**不在同一个域**（同域内的引用属该功能内部细节，不算）。

## 2. 实测基线（2026-09-29，`--queue` 与门禁实测）

| 指标                      | 实测值                                                      |
| ------------------------- | ----------------------------------------------------------- |
| `src` 文件 / 声明类型总数 | 644 / 904（导出 797 ｜ 文件私有 107）                       |
| `src/ports/**` 内类型     | 196（其中 **46 个文件需拆**，共 184 接口；12 个文件已合规） |
| `ports` 外**跨模块**接口  | **70 个，分布于 47 个文件**（= Batch B）                    |
| `ports` 外非跨模块类型    | 638 个（域内共享 531 + 文件私有 107，**不迁**）             |
| 混装文件                  | 294                                                         |
| 单文件多个导出类型        | 195                                                         |
| 依赖环                    | **6 组 / 41 个成员**（含类型边）｜**运行时环 0 组**         |
| 目标目录超 30 文件        | 无                                                          |

结论：**环全部是「类型环」，运行时无环**。所以断环的正确手段就是本队列做的事——把跨模块接口抽成基础模块，
让实现文件之间不再互相 import。904 个类型里只有 70 个真需要迁，硬搬其余 638 个只会制造噪音。

## 3. 铁律

- **R1 一接口一文件。** 一个 `.ts` 至多声明**一个** `interface` / `type`。多者拆；原文件**退化为桶**
  （`export type { X } from './<组>/X.js'`），调用点零改动。
- **R2 单向依赖。** `ports` 只被依赖，**不得**依赖 `core` / `adapters` / `config` / `composition`
  （门禁 `[3.5]` 已机器强制）；`ports` 内不得出现 `class`、不得 import 第三方裸模块（门禁 `[3]`）。
- **R3 调用点零改动。** 迁移/拆分后，**既有 import 路径必须继续可用**（原文件留桶再导出）。
  唯一允许改调用点的情况是原文件仅被同域引用且预期删除——这类改动必须单独一笔提交。
- **R4 桶文件不得再声明类型。** 退化为桶后，该文件内不得残留任何 `interface`/`type`/`class`/`function` 声明
  （门禁 `[3]` 会拦 `class`，`type`/`interface` 靠 §5 的复核命令拦）。
- **R5 目录规约。**
  - 目标子目录 `src/ports/<域>/<组>/<接口名>.ts`，其中 `<组>` = **原文件基名**（`ports/runtime/approval.ts`
    → `ports/runtime/approval/`）。这样单目录直接 `.ts` 文件数不增长，不触发门禁 `[4]` 的 >30 告警。
  - **`src/ports/adapters/**` 永不出现**——`ports` 是契约层、`adapters` 是实现层，把「适配器」当成一个契约域
    与六边形方向矛盾。适配器声明的跨模块契约按它**服务的端口域**归位（映射表见 `auditInterfaces.mjs`
    的 `ADAPTER_DOMAIN_MAP`）。
  - 新增 `ports` 域目录**必须先登记** `docs/archive/ARCHITECTURE_SPEC_2026-09.md` §2.1 归属表（仓库既有硬规定）。
- **R6 两处口径必须一致（踩过）。** 归档环时曾出现：审计脚本报 5 组、门禁报 6 组。真因是审计脚本把
  `export { X } from './y'`（**值再导出**）只记进桶表、**没记成依赖边**——而它在运行时确实会加载 `y`。
  **纪律**：任何新写的依赖图工具，都必须把「命名再导出 / `export *` / 动态 `import()`」按值边计入；
  口径不一致时以 `architectureGate.mjs` 为准并修工具，不允许「两个数字各说各话」。

## 4. 批次与顺序

> 顺序不是随意的：**Batch C 必须先决策**（否则迁入会撞名），**Batch A 必须在 Batch B 之前**
> （Batch B 的部分目标路径落在 Batch A 新建的功能组目录里）。

### Batch C — 重名冲突（3 组，先决策「合并 or 改名」）

同名接口在两个及以上文件各自声明，直接迁进 `ports` 会撞名：

| 接口名             | 声明处                                                                   |
| ------------------ | ------------------------------------------------------------------------ |
| `AgentRunner`      | `src/a2a/a2aTaskExecutor.ts` ／ `src/benchmark/terminalbench/types.ts`   |
| `ExecutionBackend` | `src/benchmark/terminalbench/types.ts` ／ `src/eval/swebenchVerified.ts` |
| `SsrfPolicyConfig` | `src/config/configFile.ts` ／ `src/security/ssrfPolicy.ts`               |

决策口径：**语义相同 → 合并为一个端口契约并删除另一份（调用点改 import）**；
**语义不同 → 改名（带语义前缀，如 `A2aAgentRunner` / `BenchmarkAgentRunner`）**。两条路都**不改行为**。

### Batch A — `src/ports/**` 内部拆分（46 文件 / 184 接口）

完整逐文件清单：`node scripts/auditInterfaces.mjs --queue` 的 **Batch A** 表。
按「导出接口数降序」执行（最大的是 `ports/model/model.ts` 14 个、`ports/tool/lsp.ts` 13 个）。

**样板（把这个例子当成模板，全批同构）：**

```
改前：src/ports/runtime/approval.ts
      export interface ApprovalPort { … }
      export interface ApprovalRequest { … }
      export interface ApprovalDecision { … }

改后：src/ports/runtime/approval/approvalPort.ts       ← 只含 ApprovalPort（文件名小驼峰，符号仍 PascalCase）
      src/ports/runtime/approval/approvalRequest.ts    ← 只含 ApprovalRequest
      src/ports/runtime/approval/approvalDecision.ts   ← 只含 ApprovalDecision
      src/ports/runtime/approval.ts                    ← 桶，内容仅三行再导出：
        export type { ApprovalPort } from './approval/approvalPort.js';
        export type { ApprovalRequest } from './approval/approvalRequest.js';
        export type { ApprovalDecision } from './approval/approvalDecision.js';
```

> **命名铁律（2026-09-30 决策）**：接口文件名必须 **camelCase**（如 `approvalPort.ts`），
> 因为铁律 `scripts/check.mjs` 规则6 要求 `src/**/*.ts` 基名匹配 `^[a-z][a-zA-Z0-9]*$`——
> 仓库内 `src/ports` / `src/core` / `src/adapters` **零** PascalCase 先例。接口**符号**仍是 PascalCase，
> 仅文件名变。`auditInterfaces.mjs` 的 `migrationTarget` / `TARGET_OVERRIDES` 已统一按 camelCase 生成目标路径。

调用点 `import type { ApprovalPort } from '../ports/runtime/approval.js'` **一字不改**。
本批收尾时更新 `src/ports/index.ts` 聚合出口（保持导出名与分区标注不变，`npm run api:check` 须仍绿）。

### Batch B — `ports` 外跨模块接口迁入（70 接口 / 47 文件）

完整清单：`--queue` 的 **Batch B** 表（已按「域外引用者数」降序 = 收益从高到低）。
执行单元是**声明文件**（47 个），不是单个接口——同一个文件里的多个跨模块接口一次改完，避免反复动同一文件。

每个接口的动作：

1. 在目标路径新建 `<接口名>.ts`，**只放该接口**（连带它依赖的、且同样跨模块的类型）；
2. 原实现文件删掉该声明，改 `import type { X } from '<ports 目标路径>'`（若文件内还要用），
   并**保留再导出桶**：`export type { X } from './…/X.js';`（R3）；
3. 若该接口在原文件里被 `class … implements X` 使用——**只用 `implements` 不算值依赖**，可直接改类型导入；
   `extends X` 才需要值导入。

**目标路径的例外**：`--queue` 给出的是默认（镜像）路径；当目标域下已有 Batch A 建好的功能组子目录时，
必须并入该组（例如 `ApprovalRule` 归入 `src/ports/runtime/approval/`，而不是平铺到 `src/ports/runtime/`）。
这类例外已显式登记在 `auditInterfaces.mjs` 的 `TARGET_OVERRIDES`——发现新的归组请**加进那张表**，
不要手工改产物、也不要改脚本里的镜像规则。

### Batch D — 收尾（Batch A/B 完成后再启动）

- 更新 `docs/PORTS_CONTRACT.md`：现行约定写的是「文件名 = 端口名，camelCase」，拆分后仍保持
  **「文件名 = 接口名的小驼峰（camelCase）」**（接口符号本身是 PascalCase，仅文件名小驼峰，
  以兼容铁律 `check.mjs` 规则6），并说明桶文件的存在。
- 混装文件 294 个：逐个判断该 `interface` 是「跨模块契约」（→ 迁 ports）还是「实现细节」（→ 降为文件私有）。
  **本批不机械执行**，逐个看，`--queue` 的 Batch A/B 两张表都不含它们即为已判定为域内细节。

#### Batch D 收尾记录（2026-10-01）

Batch A / B / C 全部完成，`--queue` 实测：

- **Batch A** `src/ports/**` 内部拆分：**0 文件 / 0 接口**（已清零，单接口文件 275 个合规）。
- **Batch B** `ports` 外跨模块接口迁入：**8 接口 / 6 文件**，且**全部被 `arch:gate [3.5]` 禁边**
  （接口体引用 `core`/`adapters`/`config`/`composition`），属「须先解耦再迁」，**本批不机械迁入**，
  留作独立的解耦重构（改名 / 抽端口），与逐接口提取分开推进：
  - `config`：`ResolvedConfig`(configFactory.ts:441)、`ExtraTool`(configFactory.ts:435)、
    `OmniHarnessConfig`(configFactory.ts:116，传递引用 `ExtraTool`)；
  - `security`：`SsrfPolicy`(ssrfPolicy.ts:119，类/接口同名合并，改名类会破调用点)；
  - `composition`：`OmniHarnessRuntime`(runtime.ts:172)；
  - `genesis`：`SparkEngines`(operators.ts:138)；
  - `mcp`：`McpServerOptions`(mcpServer.ts:41，引用 `core.ToolGate`)；
  - `plugin`：`PluginApplyContext`(pluginApplyContext.ts:12)。
- **Batch C** 重名冲突：**0 组**（SsrfPolicyConfig 合并、AgentRunner/ExecutionBackend 改名均已于前序完成）。
- **混装文件 279 个（294 → 279）**：逐个判定结论——
  - 其中 **6 个**含上述 Batch B 的 8 个跨模块接口（同文件内 `class`+`interface` 同居），判为
    「跨模块契约但被 [3.5] 阻断」→ 暂缓，随解耦重构处理；
  - 其余 **273 个**的 `interface`/`type` 均未出现在 Batch A/B 队列（即无域外引用者），按协议判据
    判为**「实现细节 / 域内共享」→ 不迁、降为文件私有或保持域内，本批零改动**。
  - 故 279 混装文件**无需机械提取**；`ports` 外非跨模块类型 624 个（域内共享 516 + 文件私有 108）同口径不迁。
- 依赖环：恒 **6 组 / 0 运行时**（全部类型环，存量白名单），重构全程未新增环。
- **`docs/PORTS_CONTRACT.md` 文件名约定已更新**：明确「每接口一 camelCase 文件 + 原文件留桶」并说明桶文件存在（见该文档 §1 末段）。

> 结论：接口层重构（Batch A/B/C + 可迁项）已收口；余数仅为 [3.5] 阻断项，需另起解耦重构批次，不在本队列机械执行范围内。

#### Batch B [3.5] 阻断项解耦收尾（2026-10-01，全部 8 接口已迁入 ports）

上表 §4 登记的 8 个 `arch:gate [3.5]` 阻断接口，经「解耦重构批次」已全部外迁到 `src/ports/**`，
原文件退化为桶再导出（调用点零改动，R3），每笔提交均经 pre-commit 门禁全绿：

| 接口（原域）                                                                | 外迁目标                                      | 提交      | 动作                       |
| --------------------------------------------------------------------------- | --------------------------------------------- | --------- | -------------------------- |
| `ExtraTool`（config）                                                       | `src/ports/tool/extraTool.ts`                 | `fcc8280` | 原文件退化纯桶             |
| `SsrfPolicy`（security）                                                    | `src/ports/security/ssrfPolicy.ts`            | `d06870f` | 原名合并，类/接口解耦      |
| `OmniHarnessConfig` / `SelfVerifyConfig` / `DecisionEngineConfig`（config） | `src/ports/config/*.ts`                       | `ce3916f` | 三配置接口外迁，桶再导出   |
| `ToolGatePort`（runtime，抽端口契约）                                       | `src/ports/runtime/toolGatePort.ts`           | `32978d5` | 解耦 `core.ToolGate` 依赖  |
| `McpServerOptions`（mcp）                                                   | `src/ports/mcp/mcpServerOptions.ts`           | `32978d5` | 外迁，桶再导出             |
| `ContainerPort`（runtime，抽端口契约）                                      | `src/ports/runtime/containerPort.ts`          | `46d58c5` | 解耦 `core` 容器依赖       |
| `PluginApplyContext`（plugin）                                              | `src/ports/plugin/pluginApplyContext.ts`      | `46d58c5` | 外迁，桶再导出             |
| `SparkEngines`（genesis）                                                   | `src/ports/genesis/sparkEngines.ts`           | `a8e211e` | 字段统一引擎端口，桶再导出 |
| `ResolvedConfig`（config）                                                  | `src/ports/config/resolvedConfig.ts`          | `4c6c6cc` | 字段统一端口契约，桶再导出 |
| `OmniHarnessRuntime`（composition）                                         | `src/ports/composition/omniHarnessRuntime.ts` | `4c6c6cc` | 字段统一端口契约，桶再导出 |

- 8 个 `[3.5]` 阻断接口已清零；`ports/**` 不再 import `core` / `adapters` / `config` / `composition`
  （`arch:gate` 实测 0 违规，`audit:standard:delta` 增量 0）。
- 下游消费者（core 三层：`stepTypes` / `stepToolExecutor` / `turnRunner`）已改依赖端口契约；
  `TurnDiffTrackerPort` 扩 `changedCount` / `getUnifiedDiff()` / `reset()` 三成员以覆盖 `TurnRunner` 使用面。
- 门禁（每笔提交均经 pre-commit 全绿，收尾复测亦全绿）：typecheck / lint / check --strict /
  arch:gate / audit:maturity / audit:standard:delta / audit:config-wiring / build，零回归。
- **结论**：Batch B「[3.5] 阻断项」已全部清偿，接口层重构队列（A / B / C / D）彻底收口。

## 5. 单文件验收协议（每个文件改完必跑，全绿才算收尾）

```bash
npm run typecheck                  # tsc --noEmit（含 web 独立编译单元）
npm run lint                       # ESLint，--max-warnings=0
npm run check -- --strict          # 铁律自检：依赖预算 / 体量红线 / 上帝类
npm run arch:gate                  # 含新加的 [5] 环门禁
npm run audit:standard:delta       # 增量标准门禁（**读暂存区**，改动记得 git add）
npm run audit:maturity             # 迁移涉及隐喻引擎时必跑
npm run api:check                  # 动了 ports 导出面 / index.ts 时必跑
```

改完立刻用审计脚本对账（**数字必须单调下降**）：

```bash
node scripts/auditInterfaces.mjs   # ports 外跨模块 70 → …；单文件多导出类型 195 → …
node scripts/architectureGate.mjs  # [5] 依赖环：某组消失或成员变少 = 断环成功
```

**门禁必须验证「能红」**：新写的检查若只跑过绿灯等于没验证。环门禁的自检方法——
临时造一对互相引用的文件（如 `src/_selftest_cycle/{a,b}.ts` 各写一行 `import(...)` 类型引用），
跑 `node scripts/architectureGate.mjs` 应 **exit 1** 并报 `[NEW!]`；删掉后应 exit 0。
（`architectureGate.mjs` 的 `CYCLE_WL_MEMBERS` **白名单口径是「成员集合」不是「整组相等」**：
环缩小 = 重构有进展 ⇒ 放行；环里出现白名单外的模块 ⇒ 红。所以白名单只减不增，清偿后删条目即可。）

**提交纪律（本仓工作区常有并行会话的未提交改动）**：

```bash
git add <只 add 本次改动的确切路径>     # 严禁 git add -A / git commit -a
git commit -m "refactor(iface/pX.Y): <动作>；<实测数字变化>"
```

**提交粒度 = 一个文件一笔**（Batch B 是一个声明文件一笔）。这样任何一笔都能单独回滚。

## 6. 进度记账

- 每次跑 `node scripts/auditInterfaces.mjs` 的四个数字就是进度条（跨模块接口 / 多导出类型文件 / 混装 / 环组数）。
- 已完成条目登记到 `docs/PROJECT_BOARD.md`（**注意**：该文件可能正被并行会话占用，先确认再写）。
- 本文件只在**口径、铁律、批次结构**变化时改；队列明细永远由 `--queue` 现生成。

## 7. 并行会话占用清单（本队列不要碰）

动手前先 `git status --short` 复核；截至 2026-09-29 工作区已有改动的文件：

`src/adapters/laya/layaDecisionEngine.ts`、`src/util/sortingAlgorithms`（+ 其测试与 `.bak`）、
`docs/PROJECT_BOARD.md`、`docs/archive/ARCHITECTURE_SPEC_2026-09.md`、`THIRD_PARTY_ASSETS.md`、`.gitignore`。

**纪律**：这些文件在本队列里**不改**，留待各自会话收尾后再回头处理（`ARCHITECTURE_SPEC_2026-09.md` 的 §2.1
登记是 Batch A 的前置项，需等它空闲时再做）。

## 8. 不要做的事（红线）

- **不为了「一文件一接口」把域内细节也搬进 `ports`。** 判据是「跨模块引用」，不是「是不是 interface」。
- **不改度量口径去凑绿。** 若必须调整阈值，先写明「原口径为什么错」。
- **不在 `ports` 里放 `class`、不放第三方 import、不放实现层依赖**（门禁 `[3]`/`[3.5]` 会红）。
- **不为拆而拆。** 已经是单接口的文件不动（Batch A 里那 12 个已合规文件就是例子）。
- **不引入任何新依赖**（本队列全程零新增依赖）。
- **不移动目录做大搬家。** 一律「新文件 + 原路径留桶」，保证可回滚、调用点零改动。
