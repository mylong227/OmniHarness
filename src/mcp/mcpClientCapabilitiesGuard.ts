/**
 * MRTR 输入请求 ↔ 客户端能力的配对校验（2026-07-28）。
 *
 * 规范硬性要求：服务端 **MUST NOT** 发送客户端未在 `clientCapabilities` 中声明的
 * 输入请求；缺能力时返回 `MissingRequiredClientCapabilityError`（`-32021`），
 * `data.requiredCapabilities` 列出缺的位。
 */
import type { McpClientCapabilities, McpInputRequests } from '../ports/mcp/mcpProtocolTypes.ts';
import { McpProtocol } from './mcpProtocol.ts';
import { McpError } from './mcpError.ts';

/** 输入方法 → 所需客户端能力键。 */
const REQUIRED_BY_METHOD: Readonly<Record<string, keyof McpClientCapabilities>> = {
  'elicitation/create': 'elicitation',
  'sampling/createMessage': 'sampling',
  'roots/list': 'roots',
};

/**
 * 能力配对校验器。
 */
export class McpClientCapabilitiesGuard {
  /**
   * 校验一组输入请求所需能力均已声明。
   * @param requests 输入请求映射。
   * @param capabilities 客户端声明的能力。
   * @throws {@link McpError} `-32021`（缺能力）或 `-32602`（未知输入方法）。
   * @returns 无返回值。
   */
  public static assertDeclared(
    requests: McpInputRequests,
    capabilities: McpClientCapabilities,
  ): void {
    const required: Record<string, Record<string, never>> = {};
    for (const request of Object.values(requests)) {
      const key = REQUIRED_BY_METHOD[request.method];
      if (key === undefined) {
        throw new McpError(
          McpProtocol.ERROR_INVALID_PARAMS,
          `不支持的 MRTR 输入方法: ${request.method}`,
        );
      }
      if (!McpClientCapabilitiesGuard.declared(capabilities[key])) {
        required[key] = {};
      }
    }
    if (Object.keys(required).length > 0) {
      throw new McpError(
        McpProtocol.ERROR_MISSING_CLIENT_CAPABILITY,
        '客户端未声明处理该输入请求所需的能力',
        { requiredCapabilities: required },
      );
    }
  }

  /**
   * 能力位是否按规范声明（必须是对象；`true`/`null`/`false` 都不算能力声明）。
   * @param value 能力值。
   * @returns 已声明为 true。
   */
  private static declared(value: unknown): boolean {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
