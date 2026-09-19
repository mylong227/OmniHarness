---
'omniharness': minor
---

补齐「不完整项」与「写了但未接线」：工具面（LSP 全局符号/浏览器截图/PTY/OS 沙箱自述/非 npm 自验证）、可观测（trace 只读自省 + TS SDK + MCP 官方 SDK）、评测与进化（RLVR 晋升准入/隔离评测/漂移检测），以及**基准可复现**（uv 定位修复）；入口可达性检测器修正后 **src 553 文件、不可达 0**。

**工具面**

- LSP：新增 `lsp_workspace_symbols`（`workspace/symbol`，不需先知道文件）、`lsp_document_symbols`（层级压平）、`lsp_code_action`（只呈现不应用），全部按能力门控注册并进规划模式只读白名单；`LspResultNormalizer` 抽离使 `LspProcessAdapter` 从 27 方法降到 16（守住「上帝类」红线）。
- 浏览器：`browser_screenshot` 产品化——注册前可用性探测（不暴露必然失败的死工具）、三类失败各给**可执行**建议（`CHROME_PATH` / `OMNI_CDP_ENDPOINT`）、跨调用复用同一 headless 浏览器、断链时在途 CDP 请求立即失败、截图经 `ToolResult.files` 附件通道返回。
- PTY：新增 `shell_interactive`（无 PTY 能力如实报错，不静默降级成管道）+ `ptyCapability`；进 `ToolGate.MUTATING_TOOLS`（不能绕过审批）。
- OS 沙箱：新增 `sandboxCapabilityTable`（`doctor` 如实打印各 profile 可达性与依据，不伪造）、`linuxLandlockSandbox`、`linuxUnshareSandbox` 与 `unshare` profile（CLI/配置枚举同步）。
- 自验证：`SelfVerifyCommandDetector` 支持非 npm 仓库（pytest/cargo/go/maven/gradle/rspec/dotnet/make），并修「显式 `selfVerify.command` 被『仓库有测试脚本』闸门否决」的断链；`testCommandNarrower` 把整仓测试收窄到失败用例。
- `htmlToText` 保留标题层级与链接（`text (URL)`，仅 http/https）。

**可观测**

- 只读 trace 自省接线：`trace.read` RPC + `omniharness trace read`（冻结快照、无写方法）；修 `ReadonlyTraceReader.byKind` 的 `seq` 语义错（过滤后子流下标 ⇒ 「按 seq 回放定位」指错）。
- TS SDK 客户端：`omniharness sdk call/ping` 打真实 `/ws`（`ping` 用真实存在的最轻 RPC，不自造方法名）。
- MCP：官方 SDK 成为 `mcp serve` 默认路径（`McpSdkProbe` 逐子路径实载探测；不可用/启动失败回落手写实现并**如实打印原因**）；新增 `GatedToolPort` 保证换实现后审批+沙箱门禁不丢。

**评测 / 进化**

- `PromotionAdmission`（多样性闸 → 退火接受 → 失败模式挖掘）接入 RLVR 晋升路径，回调只由外层控制器持（否则两级闸只是事后观测）；覆盖率低于阈值**整轮不晋升**（fail-closed + 诚实降级表述）。
- 评测隔离路由（只在快照副本上跑评测，生成方工作区不留副作用）、SWE-bench gold 漂移检测。
- `SafeRemoveTree` 入库：修 `9dc88d9` 引用未入库文件导致的**干净检出构建失败**。

**基准可复现（真缺口）**

- `NativeExecutor` 原先只用 PATH 探测 uv，而 uv 官方脚本默认装在 `~/.local/bin`（不在 PATH）⇒ 装了却判不可用、整条判定链路 fail-closed。新增 `UvLocator`（`OMNI_UV` → PATH → 平台已知位置，按目标平台拼路径，找不到列出全部候选），`describe()` 如实暴露 `uv=<路径|缺少>`，`uv venv`/`uv pip install` 改用解析出的绝对路径。
- 出数（子集口径，非官方满分；产物与命令见 `docs/TASK_BOARD.md` §15.3）：Gitee 两关 ✅✅；SWE-bench Verified 33 子集 1/33、25 子集 0/25（envError 0）；Terminal-Bench 20 题 gold 3/20、grep 基线 0/20（envError 3）⇒ **原生 Terminal-Bench 保真度不足以出官方分**（如实登记）。
- **live 真模型路径修复 + 首跑出数**：`evals/live/bench.mjs` 的 live 分支此前从未执行过，首跑即暴露两处缺陷——`main()` 里 `const cfg = resolveConfig()` 声明在 `if` 块内而标签行三元读 `cfg.model`（scripted 路径短路掩盖 ⇒ live 必抛 `ReferenceError`）；`fixTask()` 把测试文件**内容**当文件名（`seedFiles: { [testSrc]: testSrc }` ⇒ 10 个任务全 `ENOENT mkdir <测试源码>`）。修后实测：`--repeat 1` **12/12 通过**、885,596 tokens、隔离评测 12/12、exit 0；`--repeat 3 --min-pass-k 3,0.9 --min-pass-k-ci 3,0.9` ⇒ **Pass@1/2/3 = 1.000，CI=[1.000,1.000]**（bootstrap 95%、2000 轮固定种子）、2,505,441 tokens、`✅ 门禁达标`。另更正：`npm run eval:ci` 零 key（`--swebench` 走 ScriptedModel，`总 token: 0`），已实测 exit 0——旧记载说它「含真实模型调用」是错的。

**前端 F4/F5/F6/F8 收口 + `threads.rewind`**

- 重生成改为**服务端真回退**：新增 `threads.rewind`（截断持久化事件流、运行中拒绝、失败不写盘），前端先等服务端回退成功再重发，失败报因不重发；协议 schema / `docs/protocol.md` / Rust SDK fixture 同步。
- 中止**立即**收口（幂等、迟到增量丢弃）；配置保存后重拉配置并刷新厂商目录；ChangesTab hunk/文件级 accept/reject 真写回；路由未变也立即收口 + 同一会话去重 + 打开文件写 hash。

**检测器修正**：入口不再把 `src/cli/**`、`src/server/**` 整体当入口（那会让「丢进这两个目录」自动算接线，实测漏报 `sessionRewindService`），并新增「只被单测引用」判据（单测是证据、不是调用方）。
