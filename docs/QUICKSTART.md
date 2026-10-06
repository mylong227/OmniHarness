# OmniHarness 快速上手（5 分钟）

> 目标：5 分钟内**跑起来 → 看到工具轨迹 → 接上真实模型**。
> 一键启动的完整规范（前置条件、探活、停止/重启、故障排查、验收清单）见 [`STARTUP.md`](STARTUP.md)；
> 命令与旗标全集见 [`CLI_REFERENCE.md`](CLI_REFERENCE.md)；架构见 [`ARCHITECTURE_SPEC.md`](ARCHITECTURE_SPEC.md)。

---

## 1. 跑起来（一条命令）

```bash
node -v          # 需 Node ≥ 22.14.0（package.json 的 engines）
npm install
npm start        # = 构建服务端 + 构建前端 + 起 HTTP 工作台
```

浏览器打开 **<http://127.0.0.1:8787>**（默认端口；地址一律用 `127.0.0.1`，别用 `localhost`——见 `STARTUP.md` §4）。

> **为什么不是 `npm run build` 就够**：前端没有打包器，`web/index.html` 直接加载 `web/dist/main.js`，
> 而那要 `npm run web:build` 才产出。只 build 服务端会**白屏**。`npm start` 把两步都做了。

所有命令也可经 `node dist/src/cli/exec.js <子命令>` 运行（`npm i -g` 后可直接用 `omniharness <子命令>`）。

---

## 2. 零 API Key 体验（mock）

```bash
npm start -- --mock
```

在输入框下达任务（如「列出当前目录的 .md 文件并总结」），可以看到：

- **左栏**：项目切换器 + 会话列表（搜索 / 时间分组 / 「本项目 ⇄ 全部项目」）+ 工作区文件树
- **中栏**：对话 + 实时轨迹（reasoning / 工具调用树 / Diff / 流式卡片）+ 底部输入区（模型 / 推理档 / 审批 / 上下文占用 / `+` 添加菜单）
- **右栏**：工具 · 变更 · 回滚 · 治理 · 指标 · 设置 · 插件 · 编排 · 记忆 · 配置集 · 文件 · 钻取

---

## 3. 接真实模型（OpenAI 兼容端点）

**方式 A —— 命令行（临时）**

```bash
node dist/src/cli/exec.js --prompt "读取 README.md 并总结" \
  --model-adapter openai --base-url https://api.deepseek.com \
  --api-key sk-xxx --model deepseek-v4-flash --workspace .
```

**方式 B —— 用户级配置（推荐，私密凭据不进 git）**

```bash
node scripts/init-config.mjs          # 生成项目级 omniharness.json（不含凭据）
```

然后把**凭据**写进用户级配置 `~/.omniharness/omniharness.json`：

```json
{
  "modelAdapter": "openai",
  "model": "deepseek-v4-flash",
  "providerKeys": { "deepseek": "sk-xxx" }
}
```

```bash
npm start                             # 之后从任何目录启动都读同一套用户级配置
```

也可复制 [`../omniharness.json.example`](../omniharness.json.example) 改名使用。
配置字段全部落在严格白名单内（[`../src/config/configError.ts`](../src/config/configError.ts) 的 `KNOWN_KEYS`），
白名单外字段即报错——**不会静默忽略**。

> **凭据纪律**：`apiKey` / `providerKeys` 只放用户级。项目级 `omniharness.json` 里放凭据等于把 Key 提交进仓库。

**headless / CI**

```bash
node dist/src/cli/exec.js -p --prompt "..." --output-format json --approval rules --escalation deny
# → {"ok":true,"sessionId":"...","steps":N,"finalText":"..."}
```

> `--approval ask` **只在 `serve` 生效**（交互通道由 Web UI 提供）。单跑路径上没有 AskApproval 实现，
> 传它会**显式报错**而不是静默降级为全放行（fail-closed）。

---

## 4. 常用命令

```bash
# 真机单次运行
node dist/src/cli/exec.js --prompt "..." --model-adapter openai --api-key sk-xxx

# 常驻 app-server（stdio JSON-RPC，给 SDK/编辑器）
node dist/src/cli/exec.js server

# 自主目标循环
node dist/src/cli/exec.js goal "把 src 下 TODO 清理完" --goal-max-iterations 8

# DAG 工作流（定义文件是 JSON）
node dist/src/cli/exec.js workflow --file workflow.json

# 富终端 TUI（需 TTY；demo 为回声演示）
node dist/src/cli/exec.js tui [demo]

# 环境诊断 / 会话自省 / 审计
node dist/src/cli/exec.js doctor
node dist/src/cli/exec.js session list
node dist/src/cli/exec.js trace read --session ID --limit 50
node dist/src/cli/exec.js audit export

# 原生内核（可选，需 npm run native:build）
node dist/src/cli/exec.js native info
```

---

## 5. JSON-RPC 直调（UI 与脚本同一条通道）

```bash
# 记忆：列出全部长期记忆
curl -s -X POST http://127.0.0.1:8787/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"memory.list","params":{}}'

# 编排：运行已保存的 DAG
curl -s -X POST http://127.0.0.1:8787/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"graph.run","params":{"id":"demo"}}'

# 插件集：一条命令切换编码/研究模式的插件组合
node dist/src/cli/exec.js serve --plugin-profile coding

# 长期记忆加密落盘（AES-256-GCM）
node dist/src/cli/exec.js serve --memory-encrypt --memory-key-file .omniharness/longterm/memory.key
```

---

## 6. 你会想知道的几件事

| 疑问                                     | 答案                                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据存在哪？                             | 会话：`~/.omniharness/sessions/`（**全局**，按 `workspace` 标记归属）；凭据与"当前项目"：`~/.omniharness/omniharness.json`；项目设置：`<项目>/omniharness.json` |
| 为什么 UI 里只看得到部分会话？           | 缺省只显示**当前项目**；点会话区「本项目 ⇄ 全部项目」即可看全部                                                                                                 |
| 启动后为什么操作的是某个特定项目？       | 工作区解析链 = `--workspace` > **本机固定项目**（用户级配置的 `workspace`）> 启动目录；启动横幅会打印来源（见 [`STARTUP.md`](STARTUP.md) §6）                   |
| 改了前端要重启吗？                       | 用 `npm run dev`（serve + 前端 `tsc --watch`），刷新浏览器即可；改了**后端**才需要重新 `npm run build` 并重启                                                   |
| 点了「+ → 计划模式」提示"尚未创建会话"？ | 正常：会话是发第一条消息才创建的，模式已**暂存**，发送后自动生效                                                                                                |

---

## 7. 故障排查（最短路径）

- **页面白屏**：漏了 `npm run web:build`（入口 `web/dist/main.js` 不存在）→ 直接 `npm start`。
- **`EADDRINUSE`**：端口被占 → `npm start -- --port 9000`。
- **任务发下去没反应**：多半是审批卡住 → 在 UI 点「允许」，或临时 `--approval auto` / `--auto-approve`。
- **`未知旗标 --xxx`**：拼错，或该旗标未登记（fail-closed）；见 [`CLI_REFERENCE.md`](CLI_REFERENCE.md) §4。
- **配置报错「未知配置项」**：项目配置含白名单外字段（`KNOWN_KEYS`）。
- **插件不生效**：市场安装后点「重新加载」或重启 serve；`plugins.list` 看 `loaded` 标记。
- **原生后端不可用**：`native info` 显示 `available:false` → `npm run native:build`（可选功能）。

---

## 8. 下一步

- 一键启动规范与验收清单：[`STARTUP.md`](STARTUP.md)
- 命令与旗标全集：[`CLI_REFERENCE.md`](CLI_REFERENCE.md)
- 写插件：[`PLUGIN_GUIDE.md`](PLUGIN_GUIDE.md) ｜ 配置分层与安全：[`../README.md`](../README.md) §4
- 改代码的规矩：[`contributing.md`](contributing.md) ｜ 编码标准：[`CODE_STANDARD.md`](CODE_STANDARD.md)
- 文档索引（含各角色阅读路径）：[`README.md`](README.md)
