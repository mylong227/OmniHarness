# OmniHarness

> **通用 Agent Harness**：TypeScript 主体（CLI / Web 工作台 / 编排）+ Rust 原生内核（可选）。
> 一句话定位：**把"让模型在真实机器上干活"这件事做成可控、可审计、fail-closed 的工程底座**。

<p align="left">
  <a href="docs/STARTUP.md"><b>一键启动</b></a> ·
  <a href="docs/QUICKSTART.md">5 分钟上手</a> ·
  <a href="docs/CLI_REFERENCE.md">命令与旗标速查</a> ·
  <a href="docs/ARCHITECTURE_SPEC.md">架构规格</a> ·
  <a href="docs/PROJECT_BOARD.md">项目看板（唯一事实源）</a> ·
  <a href="docs/README.md">文档索引</a>
</p>

---

## 一键启动（最快、最简单）

```bash
git clone https://github.com/mylong227/OmniHarness.git
cd OmniHarness
npm install
npm start                 # = 构建服务端 + 构建前端 + 起 HTTP 工作台
```

浏览器打开 **<http://127.0.0.1:8787>**（默认端口）。第一次跑不需要任何 API Key：
不配模型时用 `mock` 适配器（脚本化响应，离线可跑演示）。

常用变体：

```bash
npm start -- --port 9000            # 换端口（参数原样透传给 serve）
npm start -- --mock                 # 明确用 mock（零额度）
npm start -- --workspace ~/work/proj  # 指定工作区（详见下文"项目固定在本机"）
npm start -- --approval rules       # 审批策略：read 放行、rm/del 拒绝、其余按规则
npm start -- --auto-approve         # 跳过审批弹窗（危险：任何工具直接放行）
npm run dev                         # 前端开发回路：serve + tsc --watch（改前端刷新即见）
```

**为什么是这三步**：本仓前端**没有打包器、也没有 dev server**——`web/index.html` 直接用
`<script type="module">` 加载 `web/dist/main.js`，而那由 `tsc -p web/tsconfig.json` 产出。
所以"把工作台跑起来"必然是 **① 编服务端（`dist/`）+ ② 编前端（`web/dist/`）+ ③ 起 `serve`（静态资源取自仓库 `web/`）**。
少任何一步的典型症状是**页面能打开但一片空白**（缺 `web/dist`）——那种"看起来像 bug 的缺失构建"最耗时间，
故本仓把它固化成一个入口 `npm start`（实现在 [`scripts/startAll.mjs`](scripts/startAll.mjs)）。
完整规范（前置条件、判定"起没起来"、停止/重启、故障排查）见 **[`docs/STARTUP.md`](docs/STARTUP.md)**。

> 想完全手敲（等价于 `npm start`）：
>
> ```bash
> npm run build && npm run web:build && node dist/src/cli/exec.js serve --port 8787
> ```

---

## 目录

- [1. 这是什么](#1-这是什么)
- [2. 核心能力](#2-核心能力)
- [3. 快速开始](#3-快速开始)
- [4. 配置：谁存在哪、谁是权威](#4-配置谁存在哪谁是权威)
- [5. Web 工作台](#5-web-工作台)
- [6. CLI 命令速查](#6-cli-命令速查)
- [7. 架构总览](#7-架构总览)
- [8. 项目结构](#8-项目结构)
- [9. 质量门禁与验证层次](#9-质量门禁与验证层次)
- [10. 诚实清单](#10-诚实清单)
- [11. 参与贡献与许可](#11-参与贡献与许可)

---

## 1. 这是什么

OmniHarness 是一个**面向真实机器操作的 Agent Harness**。它不是一个"提示词壳子"，而是把下列问题逐条变成
**有机制、有门禁、有判据**的工程实现：

- 模型要读写文件、跑命令、开浏览器、连 MCP——**边界在哪、越界怎么办**（沙箱 / 审批 / 路径守卫）；
- 长会话上下文会爆——**怎么压、什么时候压、压缩后一致性怎么保证**（压缩游标 + 不变量）；
- 多步任务要拆解与编排——**子智能体 / DAG / 目标循环怎么收敛**；
- 出了问题要能复盘——**审计日志、事件流、回放、指标**；
- 而且这些不能只写在文档里——**每一条都要有机械门禁或判据撑着**（见 [§9](#9-质量门禁与验证层次)）。

它有两种使用形态，共用同一套内核：

| 形态               | 入口                                  | 适合                                       |
| ------------------ | ------------------------------------- | ------------------------------------------ |
| **Web 工作台**     | `npm start` → `http://127.0.0.1:8787` | 可视化看轨迹、审批、指标、插件、记忆、编排 |
| **CLI / headless** | `node dist/src/cli/exec.js <子命令>`  | 脚本、CI、批处理、可复现跑测               |

---

## 2. 核心能力

### 2.1 安全执行底座（fail-closed 是默认，不是选项）

- **审批六档**：`auto` / `deny` / `rules`（默认：read 放行、`rm`/`del` 拒绝）/ `guardian` / `plan`（只读规划）/ `ask`（**仅 `serve` 支持**）。
- **沙箱多后端**：`policy`（默认，拦危险命令 + 工作区外路径）/ `restricted` / `passthrough` / OS 级（`landlock`/`seatbelt`/`bwrap`/`unshare`，本环境不可用即 fail-closed）。
- **路径守卫** `WorkspaceGuard`：工具读写被约束在工作区内，越界**报错**而不是"尽力而为"。
- **网络出站守卫** `NetworkEgressGuard`：`--network-allow host1,host2` 一旦设置即白名单外全拒（含云元数据地址 `169.254.169.254`）。
- **提权复核**：`--escalation deny|ask|auto` + `--elevated-sandbox`，提权后仍以更严策略复核。
- **未知旗标 fail-closed**：拼错的 CLI 旗标直接报错退出（而不是静默无效）——包括对**文档里写着但没登记**的旗标一并打死，见 [§9 的 `--auto-approve` 案例](#9-质量门禁与验证层次)。

### 2.2 上下文与检索

- **纯 TS BM25 + 可选语义召回**（`OMNI_SEMANTIC_RECALL=0` 可关）；召回质量有**带口径**的探针脚本
  （`npm run probe:recall`），跨仓库不承诺同一数字。
- **上下文压缩**：按 `--context-window` 的 75% 触发，压缩后**游标复位**有明确不变量约束。
- **大输出外溢**：`--spill-adapter file|memory` + `--spill-bytes` / `--spill-preview`。

### 2.3 审计与可观测

- **事件流**：`POST /rpc`（JSON-RPC 2.0）+ `GET /events`（SSE）双通道；`--output` 落 JSONL 可回放（`--replay`）。
- **审计导出**：`omniharness audit export [--compliance]`（含完整性哈希）。
- **只读自省**：`omniharness trace read --session ID`（冻结条目，不可借道改历史）。
- **指标**：token / 成本 / 步数 / 工具调用数（`/metrics`），可对账。

### 2.4 编排与执行

- **子智能体**：`--subagent-max-depth` / `--subagent-concurrency` / `--subagent-max-steps`。
- **DAG 工作流**：`omniharness workflow --file workflow.json`（多步依赖并发，前序产出注入后续）。
- **自主目标循环**：`omniharness goal "<目标>" --goal-max-iterations N`。
- **后台常驻**：`omniharness daemon start|stop|status`；**定时任务** `omniharness routines add|list|remove|run`。

### 2.5 扩展面

- **插件**（cordis-lite 形态：一目录 + `omni.plugin.json` + 入口，权限白名单 10 项 / 危险 6 项，见 [`docs/PLUGIN_GUIDE.md`](docs/PLUGIN_GUIDE.md)）。
- **MCP**：`mcp serve` 暴露本地工具 / `mcp list|call` 调用外部服务器 / `--mcp-server NAME=CMD` 直接桥接。
- **受种技能**：`--skills FILE.json`（内联在前、旗标在后、同名以旗标为准；只接受声明式子集）。
- **A2A**：`--a2a` 起对等 agent 服务端。
- **自定义工具**：`--tool ./myTool.js`（导出 `{definition, handler}` 或实现 `ToolPort`）。

### 2.6 原生内核（可选）

Rust 6 个 crate，经手写 N-API 胶水在进程内直调（Windows 上**无需 MSVC**）。默认关闭、不可用时自动回退 TS；
`npm run native:build` 后可 `omniharness native info|ping|tools|...` 验证。

---

## 3. 快速开始

### 3.1 环境要求

| 依赖             | 版本/说明                                                                            |
| ---------------- | ------------------------------------------------------------------------------------ |
| **Node.js**      | **≥ 22.14.0**（`package.json` 的 `engines`；`npm run check:node` 会机械核对）        |
| npm              | 随 Node；本仓用 npm（无 pnpm/yarn 假设）                                             |
| **Rust**（可选） | 仅原生内核 / `cargo test` 需要；Windows 用 GNU 工具链即可                            |
| 浏览器           | 现代 Chrome/Edge（Web 工作台；跑 `smoke:ui` 需要本机 Chrome 或 `OMNI_CHROME_PATH`）  |
| 真实模型（可选） | 任一 OpenAI 兼容端点（OpenAI / DeepSeek / Gemini 等），或 Anthropic / 本地 llama.cpp |

### 3.2 安装并启动

```bash
npm install
npm start
```

`npm start` 依次做：`npm run build`（服务端 → `dist/`）→ `npm run web:build`（前端 → `web/dist/`）→
`node dist/src/cli/exec.js serve`。启动横幅会打印**工作区与来源**，例如：

```
工作区: D:\work\新项目（来自本机固定项目（~/.omniharness/omniharness.json 的 workspace；用 --workspace 可覆盖））
OmniHarness UI: http://127.0.0.1:8787 （未启用鉴权；仅回环可访问）
```

### 3.3 零额度试跑（mock）

```bash
npm start -- --mock
```

在输入框下达任务（如「列出当前目录的 .md 文件并总结」），即可看到工具调用轨迹与结果。

### 3.4 接入真实模型

**方式 A —— 命令行（临时，一次性）**

```bash
node dist/src/cli/exec.js --prompt "读取 README.md 并总结" \
  --model-adapter openai --base-url https://api.deepseek.com \
  --api-key sk-xxx --model deepseek-v4-flash --workspace .
```

**方式 B —— 用户级配置（推荐，含私密凭据）**

```bash
node scripts/init-config.mjs          # 生成项目级 omniharness.json（无凭据）
# 把 Key 写进**用户级**配置（不进 git、不随项目走）：
#   ~/.omniharness/omniharness.json  →  { "providerKeys": { "deepseek": "sk-xxx" },
#                                         "modelAdapter": "openai", "model": "deepseek-v4-flash" }
npm start
```

> **凭据纪律**：`apiKey` / `providerKeys` 只放**用户级** `~/.omniharness/omniharness.json`，
> 项目级 `omniharness.json` 里永远不要放。UI 里配置 Key 时也只写用户级文件（回显一律打码）。

**headless / CI**

```bash
node dist/src/cli/exec.js -p --prompt "..." --output-format json --approval rules --escalation deny
# → {"ok":true,"sessionId":"...","steps":N,"finalText":"..."}
```

> `-p/--print` 会**拦截**交互审批：`--approval ask` 在无 stdin 的 CI 里会永久挂起，故显式报错而非静默卡死（fail-closed）。
> `--approval ask` 只在 `serve` 生效（交互通道由 Web UI 提供）；单跑路径上没有 AskApproval 实现，
> 传它会直接报错，而不会"静默降级为全放行"。

### 3.5 不想用 `npm start`？

见 [`docs/STARTUP.md`](docs/STARTUP.md)（含"只跑后端""只跑前端""换端口""后台常驻 daemon""停止与重启"）。

---

## 4. 配置：谁存在哪、谁是权威

**配置分层**（后者覆盖前者）：

```
内置默认 → 用户级 ~/.omniharness/omniharness.json → 项目级 omniharness.json
        → --profile 覆盖 → bundle 补丁层 → 环境变量 → 显式 CLI 旗标
```

| 内容                                                  | 放哪                                                                                     | 为什么                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **凭据**（`apiKey` / `providerKeys`）                 | **用户级**（`~/.omniharness/omniharness.json`）                                          | 私密数据零入库：不随项目上传                                               |
| 项目设置（模型、审批、沙箱、步数上限、插件 profile…） | 项目级 `omniharness.json`（模板 [`omniharness.json.example`](omniharness.json.example)） | 可随项目走、团队共享                                                       |
| **当前项目 + 项目列表**（`workspace` / `workspaces`） | **用户级**，且写回时把家目录下路径压成 `~/…`                                             | 这是"**本机**运行态"而非项目设置；写进项目文件会随项目上传并指向别人的路径 |
| 会话存档                                              | `~/.omniharness/sessions/*.jsonl`（全局，靠每条记录里的 `workspace` 标记归属）           | 换项目不用搬家；UI 可切「本项目 / 全部项目」                               |

### 4.1 项目固定在本机（"无论从哪启动都读得到"）

`serve` 的工作区解析链（实现在 [`src/cli/serveWorkspace.ts`](src/cli/serveWorkspace.ts)）：

```
--workspace  >  本机固定项目（~/.omniharness/omniharness.json 的 workspace）  >  启动目录
```

- 启动横幅**打印来源**（"来自本机固定项目 / 来自 --workspace / 来自启动目录"）——不做静默换根。
- 本机固定项目由 **UI 的项目切换**写入（一次点击，之后从任何目录 `npm start` 都进同一个项目）。
- 支持**可移植路径**写法：`~/work/proj`、`$HOME/work/proj`、`%USERPROFILE%\work\proj`、相对家目录——
  同一份配置换机器 / 换用户名 / 换盘符仍落到正确目录（见 [`src/util/portablePath.ts`](src/util/portablePath.ts)）。
- 固定项目路径**不存在**时：回落启动目录并如实说明，**绝不因配置问题启动不起来**。
- `serve` 默认只绑 `127.0.0.1`（要开鉴权用 `--auth-required` + `--oidc-*`）。

### 4.2 配置损坏时的行为

- 配置文件**非法 JSON** → fail-closed 报错（不静默回退空配置，否则"配置写坏了却无症状"）。
- **带 UTF-8 BOM 可以读**：Windows 上 PowerShell `Set-Content -Encoding UTF8`、记事本等写入方普遍带 BOM，
  而 BOM 属**编码层**标记而非 JSON 语法错误——故先剥 BOM 再解析，其余照旧严格。

---

## 5. Web 工作台

启动后 <http://127.0.0.1:8787>。三栏布局：

| 区域     | 内容                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| **左栏** | 项目切换器（📁）、会话列表（搜索 / 时间分组 / 卡片与文件树切换 / 拖拽排序）、工作区文件树                                   |
| **中栏** | 对话 + 实时轨迹（reasoning / 工具调用树 / Diff / 流式卡片）、底部输入区（模型 / 推理档 / 审批 / 上下文占用 / `+` 添加菜单） |
| **右栏** | 12 个标签页：工具 · 变更 · 回滚 · 治理 · 指标 · 设置 · 插件 · 编排 · 记忆 · 配置集 · 文件 · 钻取                            |

几个容易困惑的点（都已在代码与判据里定死）：

- **会话列表默认只显示当前项目**（存档是全局的，避免上千条外来会话淹没）；点会话区的
  **「本项目 / 全部项目」**按钮即切换，偏好在浏览器本地记住。
- **`+` 添加菜单里的「目标 / 计划模式 / 绘图」在还没发过消息时**是**暂存**（会话是惰性创建的）：
  界面会提示「尚未创建会话：该模式已记录，发送第一条消息后自动生效」，不是报错。
- **审批**：`--approval rules` 下危险动作会在 UI 弹出审批条；`--auto-approve` 则全部放行（慎用）。

---

## 6. CLI 命令速查

```bash
# 工作台（最常用）
node dist/src/cli/exec.js serve --port 8787 [--mock] [--auto-approve] [--workspace DIR]
node dist/src/cli/exec.js server                 # JSON-RPC stdio 常驻（给 SDK/编辑器用）

# 一次性执行
node dist/src/cli/exec.js --prompt "任务"          # 默认路径（等价 exec）
node dist/src/cli/exec.js -p --prompt "任务" --output-format json   # headless/CI

# 编排
node dist/src/cli/exec.js goal "把 src 下 TODO 清理完" --goal-max-iterations 8
node dist/src/cli/exec.js workflow --file workflow.json

# 自省 / 运维
node dist/src/cli/exec.js doctor                 # 环境诊断
node dist/src/cli/exec.js session list           # 会话列表
node dist/src/cli/exec.js trace read --session ID --limit 50
node dist/src/cli/exec.js audit export [--compliance]
node dist/src/cli/exec.js daemon start|stop|status
node dist/src/cli/exec.js --version              # 打印 API_VERSION
```

完整子命令表（27 个）与全部旗标见 **[`docs/CLI_REFERENCE.md`](docs/CLI_REFERENCE.md)**；
本机权威来源永远是 `node dist/src/cli/exec.js --help`。

---

## 7. 架构总览

### 7.1 六条不可妥协的铁律

| #   | 铁律                                                                                                       | 强制处（机械门禁）                             |
| --- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | **分层**：`ports`（契约）→ `core`（用例）→ `adapters`（实现），依赖只能向内                                | `architectureGate [1][2][3]`                   |
| 2   | **装配单点**：唯一 `new` 具体实现的位置是组合根（`src/composition/`）                                      | `architectureGate [3.5]` + `auditConfigWiring` |
| 3   | **fail-closed**：不确定就拒绝；能力不可用就如实报不可用                                                    | 各端口判据 + `tests/unit/**`                   |
| 4   | **依赖准入**（不是"零依赖"）：`ports`/`core` 恒第三方-free，其余按 D10 准入并登记                          | `dependency-allowlist.json` + `check.mjs`      |
| 5   | **编码标准**：JSDoc / 显式可见性 / 命名 / 体量阈值（单文件 ≤ 810 行；类 > 500 去注释行或 > 25 方法即违规） | `eslint` + `auditStandards` + `check.mjs`      |
| 6   | **诚实**：没做/没验证的必须写明                                                                            | `docs/PROJECT_BOARD.md` 诚实清单 + 评审五问    |

### 7.2 一回合的数据流（简化）

```
用户输入 → 组装上下文（检索/记忆/技能/工具面）→ 模型（ModelPort）
        → 工具调用意图 → 审批（ApprovalPort）→ 沙箱（SandboxPort）→ 执行 → 回灌结果
        → 循环直至收敛 → 事件流（SSE / JSONL）+ 审计 + 指标
```

关键不变量：`tool_call` 必有配对 `tool_result`；完成判定 fail-closed；取消原因保真级联；回滚后压缩游标复位。

### 7.3 原生内核（可选）

6 个 Rust crate（内核 / 沙箱 / 存储 / 策略 / 工具 / wasm），经手写 N-API 在进程内直调；TS 是默认路径。
实测原生记账比 TS 慢 4.5–6.7×，故**默认走 TS**，原生作为可选加速/落地形态。

---

## 8. 项目结构

```
src/
  ports/          契约层（31 个子目录 / 376 个 .ts；恒第三方-free）
  core/           领域用例（回合、工具门、压缩、记忆……）
  adapters/       实现（模型 / 工具 / 沙箱 / 存储 / 身份 / 企业…）
  composition/    组合根（唯一装配点）
  config/         配置加载与分层（含 BOM 容忍、白名单校验）
  capability/ asset/ governance/ license/ media/ sdk/ evolution/   能力与治理子系统
  cli/            CLI（exec / serve / goal / workflow / …）
  server/         HTTP+SSE 服务端与 JSON-RPC 处理器
web/
  index.html      工作台宿主页（零打包器，直接加载 web/dist/main.js）
  src/            前端源码（React，tsc 编译到 web/dist）
  styles/ vendor/ 样式与离线内置依赖（React/KaTeX/highlight）
  test/           前端判据（node --test）
tests/
  unit/           单元与契约判据（npm test）
  integration/    真 serve + 真 SPA + 真 Chrome 的端到端（npm run test:integration）
crates/           Rust 原生内核（可选）
scripts/          门禁、构建、跑测与一键启动（startAll/devAll/runGates/check/auditStandards…）
docs/             文档（索引见 docs/README.md；事实源见 docs/PROJECT_BOARD.md）
examples/         插件 / 目录示例
```

> 规模（2026-10-06 本机实测，逐文件求和口径）：`src/**/*.ts` **1014 文件 / 114,234 行**；
> `tests/` 501 文件 / 75,400 行；`web/src` 115 文件 / 17,648 行。数字会漂移，**以看板当期记录为准**。

---

## 9. 质量门禁与验证层次

### 9.1 门禁（单一实现 `scripts/runGates.mjs`）

| 层                | 内容                                                                                                                                    | 命令                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **fast（10 项）** | node-engine · iron-law（`check.mjs --strict`）· maturity · standard-delta · arch · wiring · doc-links · secrets · top-level-fn · eslint | `npm run check` / pre-commit 钩子 |
| **typed（2 项）** | `tsc --noEmit`（含 web）+ typed ESLint                                                                                                  | `npm run gate:typed`              |

其他常用：`npm run lint`、`npm run format:check`、`npm run check:doc-links`、`npm run audit:standard:delta`、
`npm run audit:maturity`、`npm run install-hooks`（装 git 钩子）。

### 9.2 验证层次（越往下越"真"）

| 层次           | 命令                       | 范围                                                                     |
| -------------- | -------------------------- | ------------------------------------------------------------------------ |
| 模块           | `npm test`                 | 单元 + 契约判据（数千例）                                                |
| 前端           | `npm run web:test`         | 前端逻辑与接线契约                                                       |
| 进程           | `npm run smoke:real`       | 真进程：起 serve / 跑回合（mock 模型）                                   |
| 端到端         | `npm run test:integration` | 真 serve + 真 SPA + 真 Chrome（挂载、结构基线、一条 `turns.run` 全链路） |
| 能力（真模型） | `npm run smoke:model`      | 真模型跑复杂任务（拆解 → 编排 → 实现），带模型不可见 oracle              |
| 真机 UI 场景   | `npm run smoke:ui`         | 真浏览器里的真实用户场景（11 条判据）                                    |

### 9.3 一条真实教训（说明门禁在想什么）

`serve --auto-approve` 曾是**文档与 `--help` 都写着、代码里也真的读它**的旗标，却从未登记进
`src/cli/knownFlags.ts` 的"子命令自解析旗标表"。第五十七轮把"未知旗标"改为 fail-closed 后，
它被**当场打死**（`serve --auto-approve` 直接报未知旗标退出）。2026-10-06 修好，并补上洞：
判据原先只扫描 `.value(`/`.has(` 这类**读取器**写法，漏了 `Array.includes('--x')`——
扫描面补上后**一次又揪出 3 个同类未登记旗标**（`--version`/`--compliance`/`--allow-all`）。
**结论**：判据扫不到的读取点 = 判据给不出保护。

---

## 10. 诚实清单

**没做 / 没验证的，明确列出来**（详见看板诚实清单）：

1. **单机型实测**：所有"真机"结论目前来自一台 Windows 机器；Linux/macOS 未逐项复测。
2. **真模型单一**：能力跑测主要用 DeepSeek 一家（OpenAI 兼容通道）；多厂商对比未系统化。
3. **UI 跑测边界**：`smoke:ui` 覆盖 11 条真实场景，但**不覆盖**多标签并发回合、窄屏/移动端、真实 OIDC 登录、插件安装、断线重连。
4. **召回数字**：`probe:recall` 的 hitRate 有口径与 CI 区间，但**跨仓库不承诺**同一数字。
5. **原生内核**：默认关闭；实测比 TS 慢 4.5–6.7×，仅作可选形态。
6. **跨机器可移植**：`workspace` 的 `~/…` 模板写法有单元级验证，**未真换一台机器端到端验证**。

**明确不做**：不做容器/VM 级隔离（隔离自陈 L2）；不做多租户 SaaS 控制面；不做可视化低代码编排；
不承诺任何"跑分第一"；不把归档文档当现状（归档带横幅、只读）。

---

## 11. 参与贡献与许可

- 开发流程与提交规范：[`docs/contributing.md`](docs/contributing.md)
- 编码标准（含成熟度标注机制与措辞红线）：[`docs/CODE_STANDARD.md`](docs/CODE_STANDARD.md)
- 依赖政策（D10 准入制）：[`docs/DEPENDENCY_POLICY.md`](docs/DEPENDENCY_POLICY.md)
- 端口契约（扩展前必读）：[`docs/PORTS_CONTRACT.md`](docs/PORTS_CONTRACT.md)
- 公共 API 稳定性承诺：[`docs/API_STABILITY.md`](docs/API_STABILITY.md)
- 架构规格（现行）：[`docs/ARCHITECTURE_SPEC.md`](docs/ARCHITECTURE_SPEC.md)；
  变更先落 ADR：[`docs/adr/README.md`](docs/adr/README.md)
- 许可：[Apache-2.0](LICENSE)；第三方资产见 [`THIRD_PARTY_ASSETS.md`](THIRD_PARTY_ASSETS.md)

> 文档纪律：**状态数字只认 [`docs/PROJECT_BOARD.md`](docs/PROJECT_BOARD.md)**（唯一事实源）；
> 带日期的文件是**当时快照**，不带日期的必须长期有效。改动代码请同步改动相关文档（见 contributing）。
