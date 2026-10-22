# 0013 工作区信任闸（restricted 默认 + TOFU + policy floor）

- 日期：2026-10-22
- 状态：**已实施（2026-10-22）**
- 关联：[ADR-0003 统一门禁](./0003-unified-gate-fail-closed.md)、[ADR-0006 沙箱诚实降级](./0006-sandbox-honest-degradation.md)、[ADR-0010 信任-隔离阶梯](./0010-isolation-ladder.md)、[ADR-0012 远程插件进程隔离](./0012-plugin-process-isolation.md)
- 现行实现：[`src/config/workspaceTrust.ts`](../../src/config/workspaceTrust.ts)、[`src/config/workspaceTrustStore.ts`](../../src/config/workspaceTrustStore.ts)、[`src/config/configFile.ts`](../../src/config/configFile.ts)

## 背景

配置分层会把**工作区输入**合并进运行时：项目级 `omniharness.json`、项目 `profiles/*.json`
（支持 `extends`）、`.omniharness/bundle-patches/*.json`。这些层可以声明：

- `mcpServers`：`serve`/`exec` 启动时**直接 spawn 子进程**；
- `approval` / `sandbox` / `escalation`：把审批与隔离降到最低；
- `baseUrl` / `providerKeys`：改变凭据去向；
- `media`：指定 `ffmpeg`/`ffprobe` 路径（会被执行）；
- `permission` / `ssrfPolicy` / `rbac`：放宽工具与出站策略。

于是「clone 一个仓库 → `npm start`」的信任边界，等于「执行仓库里的配置」。这与本仓已有的
插件签名、进程隔离、审计哈希链形成明显不对称：内部很严，入口很松。

## 决策

1. **默认 restricted**：未显式信任的工作区，只应用**只读语义键**（model/reasoning/storage 等）；
   其余键按权威键处理并逐条忽略，启动时打印「发现式清单」（键、来源、摘要，不回显密钥值）。
2. **显式授权**：`--trust-workspace` 写入用户级 `~/.omniharness/trust.json`；条目键为工作区
   realpath，值为项目配置 + 项目 profile（含 `extends` 合并结果）+ bundle patch 的 sha256 指纹。
3. **TOFU**：指纹变化（配置/父 profile/补丁任一内容变化）⇒ 自动退回 restricted，必须重新确认。
4. **policy floor**：即使已信任，项目级 `approval:auto`、`sandbox:passthrough`、
   `escalation:auto`、`elevatedSandbox:passthrough` 仍不生效；这四项只能由 CLI 显式旗标给出。
5. **同一条归一化**：信任判定与 `readStrict` 共用 BOM 剥离、键别名归一化、DPAPI 解密；
   否则 `base_url`/`api_key`/BOM 会造成「实际加载了、决策没看见」的绕过。
6. **分类全覆盖判据**：`ConfigError.knownKeys()` 的每个键都必须归入「安全/权威」；
   新增配置键若没归类，判据直接变红。
7. **工作区根是权威键**：`workspace`/`workspaces` 不进安全键；未信任项目不能把沙箱/工具根
   指向别的目录（`goal`/`workflow`/`tui` 与 `exec` 同一条边界）。

## 非目标

- 不替代插件签名/进程隔离：本 ADR 管「工作区配置」，签名管「制品」；
- 不防本机恶意软件：能改用户级 trust.json 的人已经拥有该用户权限；
- 不做交互式 y/N：`serve` 是常驻进程，默认 restricted + 显式旗标是可脚本化的 fail-closed；
- 不把用户级配置纳入过滤：用户自己的选择（含 `~/.omniharness/profiles`）不受工作区信任约束。

## 后果

- **兼容性**：`ConfigFile.loadLayered` 的 `trust` 选项缺省不启用，库/既有测试语义不变；
  `serve`/`exec`/TUI/RPC 四个生产入口显式传入。
- **首次体验**：克隆一个带 `mcpServers`/`approval` 的仓库会看到清单与一条 `--trust-workspace`
  指引；确认后一次授权、配置变化再确认。
- **可观测**：`doctor`/启动横幅能看到「实际生效的 approval/sandbox」；被忽略的键有可读原因。
- **边界**：信任存储是 TOFU，不是防篡改；并发授权可能丢一次条目（后写覆盖），
  但不会放宽执行面；临时文件按 1 小时清扫，避免长期运行积累。
