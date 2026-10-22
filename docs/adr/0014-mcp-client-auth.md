# 0014 MCP 客户端认证与 MRTR（第一片）

- 日期：2026-10-22
- 状态：**第一片已实施（token-based auth + RFC 9728 发现 + MRTR）；交互式授权码流未做**
- 关联：[ADR-0003 统一门禁](./0003-unified-gate-fail-closed.md)、[ADR-0013 工作区信任闸](./0013-workspace-trust.md)
- 现行实现：[`src/mcp/mcpAuthProvider.ts`](../../src/mcp/mcpAuthProvider.ts)、[`src/mcp/mcpStatelessClient.ts`](../../src/mcp/mcpStatelessClient.ts)、[`src/ports/mcp/mcpAuthConfig.ts`](../../src/ports/mcp/mcpAuthConfig.ts)

## 背景

MCP 2026-07-28 把客户端认证定为 OAuth 2.1 resource server：server 暴露 RFC 9728
受保护资源元数据，client 带 `Authorization: Bearer` 与 RFC 8707 `resource`；同时用
MRTR（`resultType:"input_required"` + `inputRequests`）取代 server 发起的 elicitation。
本仓此前只能接**匿名**远端 server，且 v2 客户端没有 `input_required` 回路。

## 决策（第一片）

1. `McpServerConfig`/`FileMcpServer` 增加 `headers` 与 `auth`；`auth` 支持
   `none` / `bearer` / `oauth`，令牌来源为配置值或 `tokenEnv`（默认不把明文写进项目文件）。
2. `McpAuthProvider` 只做两件事：把已有令牌变成 `Authorization` 头（认证头覆盖静态头）；
   通过 RFC 9728 `/.well-known/oauth-protected-resource` 发现授权服务器与 scope。发现 URL
   **path-aware**（后缀插在 host 与 path 之间），并**精确校验**返回的 `resource` 与输入一致；
   不一致即拒绝（RFC 9728 §3.3）。
3. 远端连接器把认证头传给 Streamable HTTP / SSE 传输；**缺令牌 fail-closed**，不发匿名请求。
4. `McpStatelessClient` 处理 `input_required`：把 `inputRequests` 交给注入的
   `McpInputHandler`，带 `inputResponses` 重试（≤3 轮）；无 handler/漏答/仍要求输入一律报
   `MCP_INPUT_REQUIRED`，不把半截结果当成功。本片只提供**端口**；宿主侧回答器（UI/CLI）尚未接。
5. 配置校验 fail-closed：`headers` 必须是字符串键值对象；`auth.type` 白名单且拒绝跨类型键；
   stdio 形态禁止 `headers/auth`。

## 非目标（本片明确不做）

- 浏览器授权码 + PKCE 回调、token 刷新、CIMD 注册——下一步的 `mcp auth` 命令；
- MCP registry / conformance 官方套件——本片只提供内部一致性回归（`npm run mcp:conformance`）；
- server 侧升级到 2026-07-28（等官方 SDK v2）；
- 发现请求的 SSRF/重定向防护——`discoverProtectedResource` 尚未接入运行时；接入时必须走
  `ssrfPolicy` 并拒绝跨源重定向。
