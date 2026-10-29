# Architecture Decision Records (ADR)

本目录记录 OmniHarness 的**重大架构决策**。每条 ADR 一旦接受即冻结为项目事实，
后续若推翻需新建一条状态为 `已废止` 的 ADR 并说明替代方案。

## 索引

| 编号                                         | 标题                                                    | 状态   |
| -------------------------------------------- | ------------------------------------------------------- | ------ |
| [0001](./0001-hexagonal-ports-adapters.md)   | 六边形架构：ports/adapters 分层 + 核心零第三方依赖      | 已接受 |
| [0002](./0002-dependency-allowlist.md)       | 依赖准入制（allowlist + 四闸门自检）                    | 已接受 |
| [0003](./0003-unified-gate-fail-closed.md)   | 统一门禁：审批→沙箱→执行→记录，fail-closed              | 已接受 |
| [0004](./0004-audit-hash-chain.md)           | 审计日志 SHA256 哈希链（非快照摘要）                    | 已接受 |
| [0005](./0005-event-stream-single-source.md) | 事件流为唯一真相源（投影出模型消息）                    | 已接受 |
| [0006](./0006-sandbox-honest-degradation.md) | 沙箱多后端与诚实降级（不支持即 fail-closed）            | 已接受 |
| [0007](./0007-api-stability-annotations.md)  | API 稳定性标注分区（@public/@beta/@deprecated）         | 已接受 |
| [0008](./0008-governed-evolution-kernel.md)  | 治理化进化内核（EvolutionKernel 一等域升格）            | 已接受 |
| [0009](./0009-capability-protocol.md)        | 统一资产协议（CapabilitySchema + 绞杀者迁移注册表）     | 已接受 |
| [0010](./0010-isolation-ladder.md)           | 信任-隔离阶梯（档位不可达即拒执行）                     | 已接受 |
| [0011](./0011-signed-asset-pack.md)          | 签名资产包分发（Ed25519 非对称 + 严格档 fail-closed）   | 已接受 |
| [0012](./0012-plugin-process-isolation.md)   | 远程插件进程隔离（Plugin Worker + Capability RPC）      | 提议   |
| [0013](./0013-workspace-trust.md)            | 工作区信任闸（restricted 默认 + TOFU + policy floor）   | 已接受 |
| [0014](./0014-mcp-client-auth.md)            | MCP 客户端认证与 MRTR（token + RFC 9728 + 输入回路）    | 已接受 |
| [0015](./0015-desktop-shell.md)              | 桌面壳：Electron + 固定 Node 侧车 + 回环 HTTP 契约      | 已废止 |
| [0016](./0016-native-desktop-ui.md)          | 原生桌面 UI：Avalonia 主选 / WinUI 3 备选（无 WebView） | 已废止 |
| [0017](./0017-electron-official-app.md)      | 桌面客户端：按 Codex 官方 App 的 Electron + React/TS    | 已接受 |
| [0018](./0018-antd-ui-redesign.md)           | 前端组件库：Ant Design 6 全站重做（Ant 骨架 + 纸与墨皮肤） | 提议   |

## 何时写新 ADR

当出现以下任一情况时应新建 ADR：

- 引入或推翻一种跨模块共享的架构模式（如新的端口类型、新的编排范式）；
- 改变安全/可靠性默认行为（如门禁默认从放行翻转为拦截）；
- 选定某个被多方候选淘汰的技术路线（如选定某嵌入模型、某序列化格式）；
- 建立长期工程纪律（如依赖准入、零第三方依赖铁律）。

纯局部实现细节、bug 修复、单一文件内的重构**不**需要 ADR。
