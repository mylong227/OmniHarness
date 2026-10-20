import { McpProtocol } from './mcpProtocol.ts';

/** 协商结果。 */
export type McpProtocolChoice = 'legacy' | 'stateless-v2';

/**
 * MCP 协议选择器（INT-01，2026-10-20）。
 *
 * 本仓不猜 server 支持哪版（猜错会静默降级/失败）：由显式配置 `OMNI_MCP_PROTOCOL`
 * 选择 transport。未设/未知一律走 legacy（2025-06-18 + initialize），保持既有行为；
 * 设成 `2026-07-28` 才走无状态 v2。这就是“双栈”的第一层：**选择显式、默认不漂移**。
 */
export class McpProtocolNegotiator {
  /** v2 选择值（与 `McpProtocol.PROTOCOL_VERSION_V2` 同源）。 */
  public static readonly V2 = McpProtocol.PROTOCOL_VERSION_V2;

  /**
   * 从环境变量选择协议栈。
   * @param env 环境变量（测试可注入）。
   * @returns 协议选择。
   */
  public static select(env: NodeJS.ProcessEnv = process.env): McpProtocolChoice {
    return env['OMNI_MCP_PROTOCOL'] === McpProtocolNegotiator.V2 ? 'stateless-v2' : 'legacy';
  }

  /**
   * 该协议版本是否被支持。
   * @param version 版本号。
   * @returns 支持时为 true。
   */
  public static supports(version: string): boolean {
    return version === McpProtocol.PROTOCOL_VERSION || version === McpProtocol.PROTOCOL_VERSION_V2;
  }
}
