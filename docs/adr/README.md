# Architecture Decision Records (ADR)

本目录记录 OmniHarness 的**重大架构决策**。每条 ADR 一旦接受即冻结为项目事实，
后续若推翻需新建一条状态为 `已废止` 的 ADR 并说明替代方案。

## 索引

| 编号                                         | 标题                                               | 状态   |
| -------------------------------------------- | -------------------------------------------------- | ------ |
| [0001](./0001-hexagonal-ports-adapters.md)   | 六边形架构：ports/adapters 分层 + 核心零第三方依赖 | 已接受 |
| [0002](./0002-dependency-allowlist.md)       | 依赖准入制（allowlist + 四闸门自检）               | 已接受 |
| [0003](./0003-unified-gate-fail-closed.md)   | 统一门禁：审批→沙箱→执行→记录，fail-closed         | 已接受 |
| [0004](./0004-audit-hash-chain.md)           | 审计日志 SHA256 哈希链（非快照摘要）               | 已接受 |
| [0005](./0005-event-stream-single-source.md) | 事件流为唯一真相源（投影出模型消息）               | 已接受 |
| [0006](./0006-sandbox-honest-degradation.md) | 沙箱多后端与诚实降级（不支持即 fail-closed）       | 已接受 |
| [0007](./0007-api-stability-annotations.md)  | API 稳定性标注分区（@public/@beta/@deprecated）    | 已接受 |

## 何时写新 ADR

当出现以下任一情况时应新建 ADR：

- 引入或推翻一种跨模块共享的架构模式（如新的端口类型、新的编排范式）；
- 改变安全/可靠性默认行为（如门禁默认从放行翻转为拦截）；
- 选定某个被多方候选淘汰的技术路线（如选定某嵌入模型、某序列化格式）；
- 建立长期工程纪律（如依赖准入、零第三方依赖铁律）。

纯局部实现细节、bug 修复、单一文件内的重构**不**需要 ADR。
