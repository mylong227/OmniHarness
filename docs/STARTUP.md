# 一键启动与运行规范（OmniHarness）

> **本文是"怎么把整个项目跑起来"的唯一规范**：前置条件 → 一键启动 → 判定起没起来 → 停止/重启 →
> 只用前端 / 只用后端 → 数据与配置落在哪 → 安全默认 → 故障排查 → 验收清单。
> 5 分钟上手场景见 [`QUICKSTART.md`](QUICKSTART.md)；命令与旗标全集见 [`CLI_REFERENCE.md`](CLI_REFERENCE.md)。

---

## 0. TL;DR（最快最简单）

```bash
git clone https://github.com/mylong227/OmniHarness.git
cd OmniHarness
npm install
npm start                 # 构建服务端 + 构建前端 + 起 HTTP 工作台
# → 浏览器打开 http://127.0.0.1:8787
```

**就这一条。** 需要换端口 / 换模型 / 指定项目时，参数**原样透传**给 `serve`：

```bash
npm start -- --port 9000               # 换端口
npm start -- --mock                    # 零额度（脚本化模型响应）
npm start -- --workspace ~/work/proj   # 指定项目（支持 ~ / $VAR / %VAR% 可移植写法）
npm start -- --approval auto           # 审批策略（默认 rules）
npm start -- --auto-approve            # 跳过审批弹窗（危险：所有工具直接放行）
```

---

## 1. 前置条件

| 项                   | 要求                                                                       | 检查命令      |
| -------------------- | -------------------------------------------------------------------------- | ------------- |
| **Node.js**          | **≥ 22.14.0**（`engines` 声明，门禁机械核对）                              | `node -v`     |
| npm                  | 随 Node 安装（本仓不假设 pnpm/yarn）                                       | `npm -v`      |
| 依赖                 | 首次需联网 `npm install`（含 5 个运行时依赖 + 2 个可选原生依赖）           | `npm install` |
| Rust（**可选**）     | 仅原生内核 / `cargo test` 需要；Windows 用 GNU 工具链即可，**无需 MSVC**   | `cargo -V`    |
| 浏览器               | 现代 Chrome/Edge；`npm run smoke:ui` 需要本机 Chrome 或 `OMNI_CHROME_PATH` | —             |
| 真实模型（**可选**） | OpenAI 兼容端点 / Anthropic / 本地 llama.cpp；只跑 mock 则不需要           | —             |

> Node 版本不对时**会明确失败**（`npm run check:node`），而不是跑到一半报奇怪的语法错误。

---

## 2. 为什么"一键"必须存在（本仓的构建形态）

本仓前端**没有打包器、也没有 dev server**：

- `web/index.html` 用原生 ES Module 直接加载 **`web/dist/main.js`**（URL 带时间戳防旧缓存）；
- `web/dist/**` 由 **`npm run web:build`**（`tsc -p web/tsconfig.json`）产出；
- `serve` 的静态资源取自**仓库 `web/` 目录**。

因此"把工作台跑起来"必然是三件事：

| 步  | 做什么               | 命令                              | 漏掉的症状                              |
| --- | -------------------- | --------------------------------- | --------------------------------------- |
| ①   | 编服务端 → `dist/`   | `npm run build`                   | `node dist/src/cli/exec.js` 找不到      |
| ②   | 编前端 → `web/dist/` | `npm run web:build`               | **页面能打开但一片空白**（入口 JS 404） |
| ③   | 起服务               | `node dist/src/cli/exec.js serve` | 没有可访问的地址                        |

`npm start` 就是把这三步固化成一个入口（实现：[`../scripts/startAll.mjs`](../scripts/startAll.mjs)），
**任一步失败即中止**（绝不"构建失败还起服务"——那只会让人对着旧产物调 bug）。

---

## 3. 启动方式（三选一）

### 3.1 一键启动（推荐）

```bash
npm start
```

等价手敲：

```bash
npm run build && npm run web:build && node dist/src/cli/exec.js serve
```

跳过构建（已经构建过、只想快速重启）：

```bash
npm start -- --no-build
```

### 3.2 前端开发回路（改前端不用重启后端）

```bash
npm run dev                     # 构建一次 → serve + 前端 tsc --watch
npm run dev -- --port 9000      # 参数透传
```

- 改 `web/src/**` → watch 自动重编 `web/dist/**` → **刷新浏览器**即见（无需重启 serve）。
- 改 `src/**`（后端）**不在**本回路内：需重新 `npm run build` 并重启（serve 是常驻进程，不会替换已加载的 JS）。

### 3.3 后台常驻（无人值守）

```bash
node dist/src/cli/exec.js daemon start     # 后台起 serve（PID 文件管理）
node dist/src/cli/exec.js daemon status
node dist/src/cli/exec.js daemon stop
```

---

## 4. 判定"起没起来"

**看横幅**（`npm start` 会打印两行关键信息）：

```
工作区: D:\work\新项目（来自本机固定项目（~/.omniharness/omniharness.json 的 workspace；用 --workspace 可覆盖））
OmniHarness UI: http://127.0.0.1:8787 （未启用鉴权；仅回环可访问）
```

第一行说明**它到底在操作哪个项目**（解析链：`--workspace` > 本机固定项目 > 启动目录）；
第二行是**实际绑定地址**——注意它是 `127.0.0.1` 而不是 `localhost`（本机默认只绑回环；
Windows 上 `localhost` 可能先解析到 `::1` 而连不上，脚本里请用 `127.0.0.1`）。

**探活（可复制）**：

```powershell
# PowerShell
(Invoke-WebRequest http://127.0.0.1:8787/ -UseBasicParsing).StatusCode   # 期望 200
```

```bash
# bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/           # 期望 200
```

**JSON-RPC 探活**（确认服务端逻辑通，而不只是静态页）：

```bash
curl -s -X POST http://127.0.0.1:8787/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"config.get","params":{}}'
```

---

## 5. 停止与重启

| 场景                                    | 做法                                                                |
| --------------------------------------- | ------------------------------------------------------------------- |
| 前台运行（`npm start` / `npm run dev`） | **Ctrl+C**（会连同子进程一起收走）                                  |
| 后台常驻                                | `node dist/src/cli/exec.js daemon stop`                             |
| 端口被占用                              | 换端口 `npm start -- --port 9000`；或先找出占用进程再决定是否结束它 |
| 重启（改了后端）                        | Ctrl+C → `npm start`（构建是增量的，通常十几秒）                    |

> 为什么 `npm start` 前台运行而不是自动后台：**启动横幅（工作区来源）必须看得见**。
> 静默后台启动正是"我明明配了项目却像没读到"这类问题的温床。

---

## 6. 数据与配置落在哪（"我的东西去哪了"）

| 内容                     | 位置                                                | 说明                                                                                  |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 会话存档                 | `~/.omniharness/sessions/*.jsonl`                   | **全局**目录，按每条记录里的 `workspace` 标记归属；UI 会话区可切「本项目 / 全部项目」 |
| 用户级配置（**含凭据**） | `~/.omniharness/omniharness.json`                   | `providerKeys` / `apiKey` / 默认模型 / **当前项目**（`workspace`、`workspaces`）      |
| 项目级配置               | `<项目>/omniharness.json`                           | 项目设置；**不要放凭据**                                                              |
| 插件                     | `~/.omniharness/plugins/`（或 `serve --dir`）       | 见 [`PLUGIN_GUIDE.md`](PLUGIN_GUIDE.md)                                               |
| 大输出外溢               | `<工作区>/.omniharness/spill`（默认 `file` 适配器） | `--spill-adapter memory` 可改                                                         |
| 长期记忆                 | `<工作区>/.omniharness/longterm/`                   | `--memory-encrypt` 可逐行加密                                                         |

**配置分层**（后者覆盖前者）：内置默认 → 用户级 → 项目级 → `--profile` → bundle 补丁 → 环境变量 → CLI 旗标。

**当前项目（`workspace`）只在用户级配置里**，且写回时把家目录下路径压成 `~/…`（可移植写法，见
[`../src/util/portablePath.ts`](../src/util/portablePath.ts)）——同一份配置换机器/换用户名/换盘符仍能落到正确目录。
要在别处启动也读到同一个项目：**在 UI 顶栏切一次项目**（这就是"固定在本机"的配置动作），
或直接编辑 `~/.omniharness/omniharness.json` 的 `workspace`。

---

## 7. 安全默认（别无意中开门）

| 项       | 默认                                                                       | 想放开怎么做                                                                                                     |
| -------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 监听地址 | **只绑 `127.0.0.1`**（回环）                                               | 需要局域网访问才考虑，且**必须**同时开鉴权：`--auth-required` + `--oidc-issuer/--oidc-client-id/--oidc-jwks-uri` |
| 审批     | `--approval rules`（read 放行、`rm`/`del` 拒绝、其余按规则）               | `--approval auto`（全放行）/ `--auto-approve`（启动即跳过弹窗）/ `plan`（只读规划）                              |
| 沙箱     | `--sandbox policy`（拦危险命令 + 工作区外路径）                            | 不建议 `passthrough`（全放行）；OS 级后端不可用即 fail-closed                                                    |
| 网络出站 | 未设置白名单 = 不额外限制；**一旦** `--network-allow h1,h2` 即白名单外全拒 | 按需列白名单                                                                                                     |
| 提权     | `--escalation deny`（默认不提权）                                          | `ask`（交互）或 `auto`（自动，危险动作仍 abort）                                                                 |

> `--auto-approve` 与"只绑回环但被反代出去"是**最容易出事的组合**：前者让所有工具直接跑，
> 后者让服务暴露给他人。默认配置刻意把两者都关在门外。

---

## 8. 规范（Do / Don't）

**Do**

1. 起服务用 `npm start`（或 `npm start -- --no-build` 快速重启）；**不要**只跑 `npm run build` 就开浏览器。
2. 示例地址一律写 **`http://127.0.0.1:8787`**（脚本/文档/分享链接同此）。
3. 凭据只放**用户级** `~/.omniharness/omniharness.json`；项目级配置里永远不放 Key。
4. 项目路径尽量用**可移植写法**（`~/work/proj`）或在 UI 里切换项目，别在脚本里写死某个盘符。
5. 改前端用 `npm run dev`；改后端重新 `npm run build` 并重启。
6. 交代码前跑 `npm run gate:typed`（类型层）+ 常规门禁（`pre-commit` 已自动跑 fast 层）。

**Don't**

1. 不要把 `web/dist/` 或 `dist/` 当"可选的"——两者缺一都会以"白屏/找不到入口"的形式表现为 bug。
2. 不要在 CI / 无人值守里用 `--approval ask`（会挂起；本仓已改为显式报错 fail-closed）。
3. 不要在文档里承诺"零依赖"（政策是**准入制 D10**，见 [`DEPENDENCY_POLICY.md`](DEPENDENCY_POLICY.md)）。
4. 不要用 `--workspace` 指向一个会被删除的临时目录并期待它成为长期项目。
5. 不要把归档文档（`docs/archive/**`）当现状引用。

---

## 9. 故障排查

| 症状                                                   | 多半原因                                           | 处置                                                          |
| ------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------- |
| 页面白屏 / 控制台 `main.js 404`                        | 漏了 `npm run web:build`                           | `npm run web:build` 后刷新（或直接 `npm start`）              |
| `EADDRINUSE`                                           | 端口被占                                           | `npm start -- --port 9000`                                    |
| 打开 `localhost:8787` 连不上，但 `127.0.0.1:8787` 正常 | 只绑了回环、`localhost` 解析到 `::1`               | 用 `127.0.0.1`；确需 `localhost` 请显式绑定                   |
| 启动失败：`未知旗标 --xxx`                             | 旗标拼错，或该旗标未登记（fail-closed）            | `--help` 查正确名；若是新旗标需登记进 `src/cli/knownFlags.ts` |
| 启动失败：`配置文件不是合法 JSON`                      | 配置缺逗号/多了尾逗号等真语法错                    | 修配置；**带 BOM 不是问题**（本仓已容忍 BOM）                 |
| UI 里看到的项目不是你想操作的那个                      | 解析链命中了"本机固定项目"                         | 看启动横幅第一行；用 `--workspace` 覆盖，或在 UI 顶栏切换项目 |
| 下达任务后无响应                                       | 审批卡住（`rules` 档危险动作等你在 UI 点「允许」） | 在 UI 点允许；或临时 `--approval auto` / `--auto-approve`     |
| 会话列表里"少了别的项目的会话"                         | 缺省只显示当前项目（存档是全局的）                 | 点会话区「本项目 / 全部项目」                                 |
| 点了「+ → 计划模式」提示"尚未创建会话"                 | 会话惰性创建，模式已**暂存**                       | 正常行为：发送第一条消息后自动生效                            |
| 模型调用 401/403                                       | Key 没配或配错层                                   | Key 放用户级 `providerKeys`；`omniharness doctor` 自检        |
| `native info` 显示 `available:false`                   | 未构建原生内核                                     | `npm run native:build`（可选功能，不影响 TS 路径）            |

---

## 10. 验收清单（照抄可跑）

```bash
node -v                                   # ≥ v22.14
npm install
npm start -- --port 21999 --mock          # 首次会自动构建（十几秒到一分钟）
# 另开一个终端：
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:21999/    # 期望 200
```

**通过标准**：

1. 启动横幅出现 `工作区: …（来自 …）` 与 `OmniHarness UI: http://127.0.0.1:21999` 两行；
2. 上面 `curl` 返回 `200`；
3. 浏览器打开该地址能看到三栏工作台，左栏有项目名，中栏输入框可输入；
4. 控制台**无红色报错**（本仓对"控制台零错误"有真机判据）。

---

## 11. 相关文档

| 想知道                     | 去哪                                                                          |
| -------------------------- | ----------------------------------------------------------------------------- |
| 5 分钟跑通 mock / 接真模型 | [`QUICKSTART.md`](QUICKSTART.md)                                              |
| 全部子命令与旗标           | [`CLI_REFERENCE.md`](CLI_REFERENCE.md)                                        |
| 配置分层与安全机制细节     | 仓库根 [`README.md`](../README.md) §4                                         |
| 插件怎么写                 | [`PLUGIN_GUIDE.md`](PLUGIN_GUIDE.md)                                          |
| 改代码的规矩               | [`contributing.md`](contributing.md) + [`CODE_STANDARD.md`](CODE_STANDARD.md) |
| 各门禁与验证层次           | [`README.md`](../README.md) §9 · 看板 [`PROJECT_BOARD.md`](PROJECT_BOARD.md)  |
| 文档索引                   | [`README.md`](README.md)                                                      |
