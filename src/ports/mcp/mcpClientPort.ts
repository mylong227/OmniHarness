/**
 * MCP 客户端端口：连接**单个**外部 MCP 服务器后的可用操作面。
 *
 * ## 为什么现在才抽（2026-10-02）
 *
 * 此前 `McpClient` 是 src/mcp 里的**具体类**，MCP 网关（mcpGateway）直接吃它——
 * 官方 SDK 的协议协商（2025-11-25 + 五版本向后兼容）、Streamable HTTP 远端连接因此
 * 无法接入：适配器层造得出等价实现，却塞不进一个要求具体类形参的接口。
 * 抽出本端口后，手写 `McpClient` 与官方 SDK 适配器是平级的两个实现，
 * 生产路径按「择优依赖」走 SDK，手写实现降级为纯回退资产。
 *
 * 方法面与手写实现的公开面一一对应（initialize/listTools/callTool/…/close），
 * 语义契约见 `src/mcp/mcpClient.ts` 的既有 JSDoc，本端口只收口、不改语义。
 */
import type {
  McpCallToolResult,
  McpInitializeResult,
  McpPromptDescriptor,
  McpResourceContent,
  McpResourceDescriptor,
  McpToolDescriptor,
} from './mcpProtocolTypes.js';

/**
 * @beta
 * MCP 客户端端口（握手 → 列工具 → 调工具 / 资源 / 提示模板）。
 */
export interface McpClientPort {
  /**
   * 握手，返回服务端信息与能力。
   *
   * @returns initialize 结果（协议版本 / 能力 / serverInfo）。
   */
  initialize(): Promise<McpInitializeResult>;

  /**
   * 列举远端工具。
   *
   * @returns 工具描述列表（服务端未声明 tools 能力时为空列表）。
   */
  listTools(): Promise<readonly McpToolDescriptor[]>;

  /**
   * 调用远端工具。
   *
   * @param name 远端工具名（**不带**本地注册时加的服务器前缀）。
   * @param args 工具实参。
   * @returns 调用结果（isError=true 表示远端工具自身报告失败）。
   */
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult>;

  /**
   * 列举远端资源。
   *
   * @returns 资源描述列表。
   */
  listResources(): Promise<readonly McpResourceDescriptor[]>;

  /**
   * 读取远端资源。
   *
   * @param uri 资源 URI。
   * @returns 资源内容。
   */
  readResource(uri: string): Promise<McpResourceContent>;

  /**
   * 列举远端提示模板。
   *
   * @returns 提示模板描述列表。
   */
  listPrompts(): Promise<readonly McpPromptDescriptor[]>;

  /**
   * 获取远端提示模板。
   *
   * @param name 模板名。
   * @param args 模板实参（缺省空对象）。
   * @returns 首条消息的文本内容（缺失为空串）。
   */
  getPrompt(name: string, args?: Record<string, unknown>): Promise<string>;

  /**
   * 心跳检测。
   *
   * @returns 服务端可响应为 true（任何失败一律收敛为 false，不抛错）。
   */
  ping(): Promise<boolean>;

  /**
   * 关闭连接：立即拒绝全部在途请求（fail-fast），此后拒绝新请求。
   *
   * @param reason 拒绝原因（用于错误消息）。
   * @returns 无返回值。
   */
  close(reason?: string): void;
}
