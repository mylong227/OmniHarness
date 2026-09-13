# OmniHarness 快速上手

> 零运行时依赖的 TypeScript 端口-适配器 Agent Harness + Rust 硬内核。
> 本指南让你 5 分钟内跑通 mock、接上真实模型、打开 Web 工作台。
> 完整架构见 `docs/ARCHITECTURE_SPEC.md`，插件开发见 `docs/PLUGIN_GUIDE.md`。

## 1. 安装与构建

```bash
node -v        # 需 Node 20+
npm install
npm run build  # 等同 package.json 的 prepare，产出 dist/
npm test       # 全量单测（当前 471 通过 / 0 失败 / 3 跳过）
```

所有命令经 `node dist/src/cli/exec.js <子命令>` 运行。

## 2. 一分钟 mock 体验（无需任何 API Key）

```bash
node dist/src/cli/exec.js serve --mock --port 8787
```

浏览器打开 http://localhost:8787 —— 零依赖三栏工作台：

- **左**：会话列表 + 工作区文件树
- **中**：对话 + 实时轨迹流（reasoning / 工具调用树 / DiffBlock）
- **右**：设置（运行时改配置）、指标、插件市场、记忆、编排、配置集

在对话框下达任务（如「列出当前目录的 .md 文件并总结」），即可看到工具调用轨迹。

> 未找到 `omniharness.json` 时会在 stderr 提示，可忽略（默认 mock 模型）。

## 3. 接入真实模型（OpenAI 兼容端点）

**方式 A — 命令行参数（临时）：**

```bash
node dist/src/cli/exec.js --prompt "读取 README.md 并总结" \
  --model-adapter openai --base-url https://api.deepseek.com \
  --api-key sk-xxx --model deepseek-chat --workspace D:/deepseek/omniharness
```

**方式 B — 配置文件（推荐，长期）：**

```bash
node scripts/init-config.mjs          # 在 cwd 生成 omniharness.json
# 编辑 apiKey / baseUrl / model 后
node dist/src/cli/exec.js serve --port 8787
```

配置字段全部落在严格白名单内（`src/config/configLayer.ts` 的 `KNOWN_KEYS`）。
也可直接复制 `omniharness.json.example` 改名使用。

## 4. Web 工作台速览

| 区域     | 能力                                                                                          |
| -------- | --------------------------------------------------------------------------------------------- |
| 设置     | 运行时改模型/审批/沙箱/工作区 → `config.update`（落盘 `omniharness.json`，凭据/工作区不回写） |
| 指标     | token / 成本 / 步数 / 工具调用数（`/metrics`）                                                |
| 插件市场 | 搜索/安装/卸载/重新加载；危险权限高亮                                                         |
| 记忆     | 检索/增/改/删长期记忆（`memory.*`）；可选 AES-256-GCM 加密                                    |
| 编排     | 声明式 Agent 图（DAG）编辑与实时运行（`graph.*`）                                             |
| 配置集   | 命名插件组合切换 + bundle 打包/解包（`profile.*` / `bundle.*`）                               |

## 5. 常用 CLI 速查

```bash
# 真机单次运行
node dist/src/cli/exec.js --prompt "..." --model-adapter openai --api-key sk-xxx

# 常驻 app-server（stdio JSON-RPC）
node dist/src/cli/exec.js server

# 自主长循环（goal / ralph）
node dist/src/cli/exec.js goal "把 src 下 TODO 清理完"

# 多 Agent 工作流（workflow DAG）
node dist/src/cli/exec.js workflow run ./my-flow.yaml

# 富终端 TUI（需 TTY）
node dist/src/cli/exec.js tui

# 原生 FFI 后端（Rust 内核 in-process）
node dist/src/cli/exec.js native info

# 环境诊断
node dist/src/cli/exec.js doctor
```

## 6. 一键能力（JSON-RPC 直调）

```bash
# 记忆：列出全部长期记忆
curl -s -X POST localhost:8787/rpc -d '{"method":"memory.list","params":{}}'

# 编排：运行已保存的 DAG
curl -s -X POST localhost:8787/rpc -d '{"method":"graph.run","params":{"id":"demo"}}'

# 配置集：切换编码/研究模式插件组合
node dist/src/cli/exec.js serve --plugin-profile coding

# 记忆加密：启用 AES-256-GCM 落盘
node dist/src/cli/exec.js serve --memory-encrypt --memory-key-file .omniharness/memory.key
```

## 7. 故障排查

- **serve 挂起**：Web UI 下达任务后无响应 → 多半是审批卡住；用 `--auto-approve` 或在 UI 点「允许」。
- **配置报错「未知配置项」**：检查 `omniharness.json` 是否含白名单外字段（见 `KNOWN_KEYS`）。
- **插件不生效**：市场安装后点「重新加载」或重启 serve；`plugins.list` 看 `loaded` 标记。
- **原生后端不可用**：`native info` 显示 `available:false` → 先 `npm run native:build`。

进一步阅读：`docs/README.md`（文档索引）· `docs/ARCHITECTURE_SPEC.md` · `docs/integration.md` · `docs/PLUGIN_GUIDE.md` · `docs/contributing.md`。
