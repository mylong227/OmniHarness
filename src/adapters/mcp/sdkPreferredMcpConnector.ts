/**
 * 「SDK 优先、手写回退」的 MCP 连接器（生产装配默认注入）。
 *
 * ## 选择纪律（与 McpServeRunner 的 serve 方向同口径，绝不静默降级）
 *
 *   1. 默认走官方 SDK 连接器（协议协商 + stdio/远端 url 二形态）；
 *   2. SDK 连接失败 → 回落手写 `McpConnector`（仅 stdio 形态），并把**失败原因如实打到
 *      stderr**（生产可见回退发生了、为什么发生）；
 *   3. 远端 `url` 形态手写实现不支持 → 不回落，原样抛出 SDK 的错误
 *      （回落一个必然失败的实现只会把真错误埋进假错误里）。
 *
 * 回退不是 forever：手写 `src/mcp/*` 按 allowlist exitPlan 保留为资产，
 * SDK 停更时组合根切回 `connector: mcpConnector` 即回到历史行为。
 */
import { SdkMcpConnector } from './sdkMcpConnector.js';
import { mcpConnector } from '../../mcp/mcpConnector.js';
import type { McpConnectionHandle, McpConnectorPort } from '../../ports/mcp/mcpConnectorPort.js';
import type { McpServerConfig } from '../../ports/mcp/mcpServerConfig.js';

/** 依赖注入（可测试性：单测注入假连接器验证三条路径）。 */
export interface SdkPreferredMcpConnectorDeps {
  /** SDK 连接器（缺省真实 {@link SdkMcpConnector}）。 */
  readonly sdk?: McpConnectorPort | undefined;
  /** 手写回退连接器（缺省组合根单例 `mcpConnector`）。 */
  readonly fallback?: McpConnectorPort | undefined;
  /** 回退提示输出通道（缺省 stderr；测试注入收集器断言不静默）。 */
  readonly write?: ((text: string) => void) | undefined;
}

/**
 * SDK 优先、手写回退的 MCP 连接器。
 */
export class SdkPreferredMcpConnector implements McpConnectorPort {
  /** SDK 连接器。 */
  private readonly sdk: McpConnectorPort;
  /** 手写回退连接器。 */
  private readonly fallback: McpConnectorPort;
  /** 回退提示输出通道。 */
  private readonly write: (text: string) => void;

  /**
   * @param deps 依赖（均可缺省，缺省走真实 SDK / 手写单例 / stderr）
   */
  public constructor(deps: SdkPreferredMcpConnectorDeps = {}) {
    this.sdk = deps.sdk ?? new SdkMcpConnector();
    this.fallback = deps.fallback ?? mcpConnector;
    this.write = deps.write ?? ((text) => process.stderr.write(text));
  }

  /**
   * 建立连接：SDK 优先；stdio 形态失败回落手写并如实告知，url 形态不回落。
   *
   * @param server 服务器配置（stdio 给 command/args/env/cwd；远端给 url）。
   * @param timeoutMs 每请求超时（毫秒；缺省由实现决定）。
   * @returns 连接句柄（client + init 信息 + close）。
   */
  public async connect(
    server: McpServerConfig,
    timeoutMs?: number | undefined,
  ): Promise<McpConnectionHandle> {
    try {
      return await this.sdk.connect(server, timeoutMs);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (server.url !== undefined) {
        // 远端形态手写实现不支持：回落必然失败，只会把真错误埋进假错误里。
        throw error;
      }
      this.write(`[omniharness] MCP SDK 连接 "${server.name}" 失败（${reason}），回落手写实现\n`);
      return await this.fallback.connect(server, timeoutMs);
    }
  }
}
