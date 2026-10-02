/**
 * @beta
 * 单个 MCP 服务器配置。
 *
 * 已从 `mcp/mcpGateway.ts` 外迁到 ports/mcp：原文件退化为纯再导出桶，调用点零改动。
 * 同域 `McpServerOptions` 也已外迁至 `ports/mcp/mcpServerOptions.ts`，其 `gate` 现引用 ports 层
 * `ToolGatePort`（不再依赖 core 实现），`ports→core` 禁边已解除。
 *
 * 2026-10-02 起支持两种形态（二选一，配置校验 fail-closed）：
 * - **stdio 本地进程**：`command`（+ `args`/`env`/`cwd`）——由连接器 spawn 子进程；
 * - **远端 url**：`url`（http/https）——经官方 SDK 连接器走 Streamable HTTP/SSE。
 * `command` 因此改为可选；只吃 stdio 的手写连接器在收到 `url` 或缺 `command`
 * 的配置时会给出可行动的显式报错（绝不静默 spawn 空命令）。
 */
export interface McpServerConfig {
  /** 服务器别名（用作工具名前缀，避免跨服务器重名）。 */
  readonly name: string;
  /** 本地子进程命令（stdio 形态必填；url 形态必须为空）。 */
  readonly command?: string;
  /** 子进程参数（stdio 形态）。 */
  readonly args?: readonly string[];
  /** 子进程环境变量（stdio 形态）。 */
  readonly env?: Record<string, string>;
  /** 子进程工作目录（stdio 形态）。 */
  readonly cwd?: string;
  /** 远端服务器地址（http/https，url 形态必填；command 形态必须为空）。 */
  readonly url?: string;
}
