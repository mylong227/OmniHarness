/**
 * MCP 2026-07-28 订阅服务（`subscriptions/listen` 的生命周期与通知分发）。
 *
 * 从 `McpServer` 拆出的第一条职责线：
 *  - 校验 `listen` 必须是现代（每请求 `_meta`）请求，并规整 `notifications` 过滤参数；
 *  - 选择该请求的写入通道（传输支持按请求分流则分流，否则回落共享通道）；
 *  - 把发布事件交给订阅中枢，并对外提供「取消单条 / 关闭全部」入口。
 *
 * 协议语义（ack 首条、`subscriptionId`、优雅关闭、容量 fail-closed）仍由
 * {@link McpSubscriptionHub} 承载；本类只负责编排与错误码映射。
 */
import type { McpSubscriptionFilter } from '../ports/mcp/mcpProtocolTypes.ts';
import type { RequestId } from '../ports/server/requestId.ts';
import type { SubscriptionChannel } from '../ports/server/subscriptionChannel.ts';
import type { Transport } from '../ports/server/transport.ts';
import type { ParsedMcpRequestContext } from './mcpRequestContext.ts';
import { McpError } from './mcpError.ts';
import { McpProtocol } from './mcpProtocol.ts';
import { McpSubscriptionHub, type McpSubscriptionEvent } from './mcpSubscriptionHub.ts';

/**
 * 订阅服务：`subscriptions/listen` 建立、事件发布与关闭。
 */
export class McpSubscriptionService {
  /** 订阅中枢（并发上限与过滤匹配都在中枢内）。 */
  private readonly hub: McpSubscriptionHub;
  /** 传输层（用于按请求开流与共享通道回落）。 */
  private readonly transport: Transport;

  /**
   * @param transport 传输层。
   * @param max 并发订阅上限（默认 64；超限 fail-closed）。
   */
  public constructor(transport: Transport, max = 64) {
    this.transport = transport;
    this.hub = new McpSubscriptionHub(max);
  }

  /**
   * 打开 `subscriptions/listen` 长生命周期流（ack 由中枢在该通道首发）。
   * @param params 请求参数（`notifications` 过滤器）。
   * @param context 请求上下文。
   * @param requestId 请求 id（同时作为 subscriptionId）。
   * @returns 无返回值。
   */
  public listen(
    params: Record<string, unknown>,
    context: ParsedMcpRequestContext,
    requestId: RequestId,
  ): void {
    if (!context.modern) {
      throw new McpError(
        McpProtocol.ERROR_INVALID_PARAMS,
        'subscriptions/listen 需要 2026-07-28 每请求 _meta',
      );
    }
    const filter = this.filterOf(params['notifications']);
    const channel = this.channelOf(requestId);
    try {
      this.hub.register(requestId, filter, channel);
    } catch (error) {
      throw new McpError(
        McpProtocol.ERROR_INTERNAL,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * 发布事件给所有匹配的订阅。
   * @param event 事件。
   * @returns 实际发送的通知条数。
   */
  public publish(event: McpSubscriptionEvent): number {
    return this.hub.publish(event);
  }

  /**
   * 关闭全部订阅（服务端停机；先发完成响应再关流）。
   * @returns 关闭的订阅数。
   */
  public closeAll(): number {
    return this.hub.closeAll();
  }

  /**
   * 按请求 id 取消一条订阅（`notifications/cancelled`；非 id 值忽略）。
   * @param requestId 取消请求里的目标 id（未知形状一律忽略）。
   * @returns 无返回值。
   */
  public cancel(requestId: unknown): void {
    if (typeof requestId === 'number' || typeof requestId === 'string') {
      this.hub.close(requestId);
    }
  }

  /**
   * 为 listen 请求选通道：传输支持按请求分流则用它，否则回落共享通道。
   * @param id 请求 id。
   * @returns 订阅通道。
   */
  private channelOf(id: RequestId): SubscriptionChannel {
    const split = this.transport.openSubscription?.(id);
    if (split !== undefined) return split;
    return {
      send: (message) => this.transport.send(message),
      close: () => undefined,
    };
  }

  /**
   * 规整 `notifications` 过滤参数。
   * @param raw 原始值。
   * @returns 过滤器（缺省空对象）。
   */
  private filterOf(raw: unknown): McpSubscriptionFilter {
    if (raw === undefined) return {};
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new McpError(McpProtocol.ERROR_INVALID_PARAMS, 'notifications 过滤器必须是对象');
    }
    const record = raw as Record<string, unknown>;
    const uris = record['resourceSubscriptions'];
    if (uris !== undefined && !Array.isArray(uris)) {
      throw new McpError(
        McpProtocol.ERROR_INVALID_PARAMS,
        'notifications.resourceSubscriptions 必须是字符串数组',
      );
    }
    return {
      ...(record['toolsListChanged'] === true ? { toolsListChanged: true } : {}),
      ...(record['promptsListChanged'] === true ? { promptsListChanged: true } : {}),
      ...(record['resourcesListChanged'] === true ? { resourcesListChanged: true } : {}),
      ...(Array.isArray(uris)
        ? {
            resourceSubscriptions: uris.filter(
              (uri): uri is string => typeof uri === 'string' && uri !== '',
            ),
          }
        : {}),
    };
  }
}
