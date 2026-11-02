import { McpProtocol } from './mcpProtocol.ts';

/** 协商结果：显式 legacy / 显式 stateless-v2 / 默认自动探测。 */
export type McpProtocolChoice = 'legacy' | 'stateless-v2' | 'auto';

/**
 * MCP 协议选择器（INT-01，2026-10-20；2026-10-21 默认改为 auto）。
 *
 * 默认 `auto`（未设/空/`auto`）：先尝试 2026-07-28 无状态发现，失败再回退
 * 2025-06-18 + initialize——这样新 server 开箱可接，旧 server 也不会被破坏。
 * 显式 `2026-07-28` 只走 v2（失败即报错，不再回退）；显式 `legacy` 只走旧栈。
 * **不猜版本**：v2 先试、失败回退是显式写在连接器里的，不是把未知值当 legacy。
 */
export class McpProtocolNegotiator {
  /** v2 选择值（与 `McpProtocol.PROTOCOL_VERSION_V2` 同源）。 */
  public static readonly V2 = McpProtocol.PROTOCOL_VERSION_V2;

  /**
   * 从环境变量选择协议栈。
   * @param env 环境变量（测试可注入）。
   * @returns 协议选择（缺省 auto）。
   */
  public static select(env: NodeJS.ProcessEnv = process.env): McpProtocolChoice {
    const raw = env['OMNI_MCP_PROTOCOL']?.trim();
    if (raw === McpProtocolNegotiator.V2) return 'stateless-v2';
    if (raw === 'legacy') return 'legacy';
    return 'auto';
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
