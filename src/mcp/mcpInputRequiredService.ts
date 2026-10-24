/**
 * MCP 2026-07-28 MRTR 服务（`input_required` 的裁决与 `requestState` 编解码）。
 *
 * 从 `McpServer` 拆出的第二条职责线：
 *  - 首次调用：把 `tools/call` 交给 live handler 评估；
 *  - 重试调用：验签 `requestState`（方法 + 参数摘要 + TTL 绑定）、解析 `inputResponses`，
 *    再把上一轮的业务状态回灌给 handler；
 *  - `input_required` 时构造中间结果并**密封**新一轮 `requestState`；
 *  - legacy 客户端与未声明能力的现代客户端一律 fail-closed。
 *
 * 纯校验/形状收敛（`inputResponsesOf` / `recordOf`）与摘要计算都在本类内，
 * `McpServer` 只保留一行委托。
 */
import { randomBytes } from 'node:crypto';
import type { ToolCall } from '../ports/tool/tool.ts';
import type { McpInputResponses, McpServerInfo } from '../ports/mcp/mcpProtocolTypes.ts';
import type { McpInputRequiredDecision } from '../ports/mcp/mcpInputRequiredPort.ts';
import type { McpServerOptions } from '../ports/mcp/mcpServerOptions.ts';
import { log } from '../util/logger.ts';
import { McpClientCapabilitiesGuard } from './mcpClientCapabilitiesGuard.ts';
import { McpError } from './mcpError.ts';
import { McpProtocol } from './mcpProtocol.ts';
import type { ParsedMcpRequestContext } from './mcpRequestContext.ts';
import { McpRequestStateCodec } from './mcpRequestStateCodec.ts';

/**
 * MRTR 服务：裁决 → 中间结果 / 重试状态。
 */
export class McpInputRequiredService {
  /** 服务端选项（port 与会话 id 按调用时读取，语义与拆分前一致）。 */
  private readonly options: McpServerOptions;
  /** `requestState` 编解码器（HMAC + TTL + 方法/摘要绑定）。 */
  private readonly requestState: McpRequestStateCodec;
  /** 对外上报的服务端信息（只用于中间结果 `_meta`）。 */
  private readonly serverInfo: McpServerInfo;

  /**
   * @param options 服务端选项（取 `inputRequired` / `context` / 状态密钥与 TTL）。
   * @param serverInfo 对外上报的服务端信息。
   */
  public constructor(options: McpServerOptions, serverInfo: McpServerInfo) {
    this.options = options;
    this.serverInfo = serverInfo;
    this.requestState = new McpRequestStateCodec(
      options.requestStateSecret ??
        process.env['OMNI_MCP_REQUEST_STATE_SECRET'] ??
        randomBytes(32).toString('hex'),
      options.requestStateTtlMs ?? McpRequestStateCodec.DEFAULT_TTL_MS,
    );
  }

  /**
   * 评估 MRTR：验签 `requestState` → 调 live handler。
   * @param call 工具调用。
   * @param params 请求参数。
   * @param context 请求上下文。
   * @returns 裁决（input_required 时能力已校验）。
   */
  public async decide(
    call: ToolCall,
    params: Record<string, unknown>,
    context: ParsedMcpRequestContext,
  ): Promise<McpInputRequiredDecision> {
    const port = this.options.inputRequired;
    if (port === undefined) return { kind: 'allow' };
    const digest = this.stateDigestOf(call);
    const stateRaw = params['requestState'];
    let attempt = 0;
    let responses: McpInputResponses | undefined;
    let state: Readonly<Record<string, unknown>> | undefined;
    if (stateRaw !== undefined) {
      if (typeof stateRaw !== 'string') {
        throw new McpError(McpProtocol.ERROR_INVALID_PARAMS, 'requestState 必须是字符串');
      }
      const opened = this.requestState.open(stateRaw, McpProtocol.METHOD_TOOLS_CALL, digest);
      if (!opened.ok) throw new McpError(McpProtocol.ERROR_INVALID_PARAMS, opened.reason);
      attempt = 1;
      responses = this.inputResponsesOf(params['inputResponses']);
      state = this.recordOf(opened.data);
    } else if (params['inputResponses'] !== undefined) {
      throw new McpError(
        McpProtocol.ERROR_INVALID_PARAMS,
        '重试携带 inputResponses 但缺少 requestState（fail-closed）',
      );
    }
    const decision = await port.evaluate({
      call,
      sessionId: this.options.context.sessionId,
      attempt,
      clientCapabilities: context.clientCapabilities,
      modern: context.modern,
      ...(responses !== undefined ? { inputResponses: responses } : {}),
      ...(state !== undefined ? { state } : {}),
    });
    if (decision.kind !== 'input_required') return decision;
    if (!context.modern) {
      return {
        kind: 'deny',
        message: 'MRTR input_required 需要 2026-07-28 每请求能力；legacy 客户端 fail-closed',
      };
    }
    McpClientCapabilitiesGuard.assertDeclared(decision.inputRequests, context.clientCapabilities);
    return decision;
  }

  /**
   * 构造 `input_required` 结果（密封 requestState）。
   * @param decision 裁决。
   * @param call 工具调用。
   * @returns MRTR 中间结果。
   */
  public resultOf(
    decision: Extract<McpInputRequiredDecision, { kind: 'input_required' }>,
    call: ToolCall,
  ): unknown {
    const digest = this.stateDigestOf(call);
    const requestState = this.requestState.seal(
      McpProtocol.METHOD_TOOLS_CALL,
      digest,
      decision.state ?? null,
    );
    if (decision.reason !== undefined) {
      log.debug('mcp.mrtr.input_required', { tool: call.name, reason: decision.reason });
    }
    return {
      resultType: 'input_required',
      inputRequests: decision.inputRequests,
      requestState,
      _meta: { [McpProtocol.META_SERVER_INFO]: this.serverInfo },
    };
  }

  /**
   * MRTR 状态绑定摘要（会话 + 方法参数；防跨会话/跨请求重用）。
   * @param call 工具调用。
   * @returns 稳定摘要。
   */
  private stateDigestOf(call: ToolCall): string {
    return McpRequestStateCodec.digestOf({
      sessionId: this.options.context.sessionId,
      name: call.name,
      arguments: call.arguments,
    });
  }

  /**
   * 解析 `inputResponses`（规范形状是对象映射；数组形态 fail-closed）。
   * @param raw 原始值。
   * @returns 回答映射。
   */
  private inputResponsesOf(raw: unknown): McpInputResponses {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new McpError(
        McpProtocol.ERROR_INVALID_PARAMS,
        'inputResponses 必须是对象映射（键为 inputRequests 的 id）',
      );
    }
    return raw as McpInputResponses;
  }

  /**
   * 把未知值收敛为记录（非对象 → 空对象）。
   * @param value 原始值。
   * @returns 记录。
   */
  private recordOf(value: unknown): Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
