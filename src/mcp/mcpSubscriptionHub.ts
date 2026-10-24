/**
 * MCP 2026-07-28 订阅中枢（`subscriptions/listen`）。
 *
 * 职责边界：
 *  - **协议**：ack 必须是该订阅流上的第一条消息；每条通知都带
 *    `_meta["io.modelcontextprotocol/subscriptionId"]`；优雅关闭先发完成响应再关流。
 *  - **过滤**：客户端没显式订阅的通知类型一律不发（规范硬性要求）。
 *  - **容量**：并发订阅有上限，超限 fail-closed（拒绝新 `listen`），不静默丢弃。
 *
 * 具体传输（stdio 共享通道 / Streamable HTTP 的 POST 响应流）由 {@link SubscriptionChannel}
 * 抽象；本类不碰 socket。
 */
import type { RequestId } from '../ports/server/requestId.ts';
import type { SubscriptionChannel } from '../ports/server/subscriptionChannel.ts';
import type { McpSubscriptionFilter } from '../ports/mcp/mcpProtocolTypes.ts';
import { jsonRpc, type RpcNotification } from '../server/core/jsonRpc.ts';
import { McpProtocol } from './mcpProtocol.ts';

/** 服务端可发布的订阅事件（与过滤器字段一一对应）。 */
export type McpSubscriptionEvent =
  | { readonly kind: 'toolsListChanged' }
  | { readonly kind: 'promptsListChanged' }
  | { readonly kind: 'resourcesListChanged' }
  | { readonly kind: 'resourceUpdated'; readonly uri: string };

/** 一条已建立的订阅。 */
interface ActiveSubscription {
  /** 原始 JSON-RPC 请求 id（同时是 subscriptionId）。 */
  readonly id: RequestId;
  /** 客户端请求的过滤条件（已规整）。 */
  readonly filter: McpSubscriptionFilter;
  /** 该订阅的写入通道。 */
  readonly channel: SubscriptionChannel;
}

/**
 * 订阅中枢。
 */
export class McpSubscriptionHub {
  /** 活跃订阅（键为 JSON-RPC id，即 subscriptionId）。 */
  private readonly active = new Map<string, ActiveSubscription>();
  /** 并发上限。 */
  private readonly max: number;

  /**
   * @param max 并发订阅上限（默认 64）。
   */
  public constructor(max = 64) {
    this.max = Math.max(1, Math.trunc(max));
  }

  /**
   * 当前订阅数（观测/测试用）。
   * @returns 活跃订阅数。
   */
  public size(): number {
    return this.active.size;
  }

  /**
   * 建立订阅并**先发 ack**。
   * @param id `subscriptions/listen` 的 JSON-RPC id（同时作为 subscriptionId）。
   * @param requested 客户端请求的过滤条件。
   * @param channel 该请求的响应流通道。
   * @throws 超过并发上限时抛错（调用方转成 JSON-RPC 错误，不静默丢订阅）。
   * @returns 无返回值。
   */
  public register(
    id: RequestId,
    requested: McpSubscriptionFilter,
    channel: SubscriptionChannel,
  ): void {
    if (this.active.size >= this.max) {
      throw new Error(`MCP 并发订阅数超过上限 ${String(this.max)}`);
    }
    const filter = McpSubscriptionHub.normalizeFilter(requested);
    this.active.set(McpSubscriptionHub.keyOf(id), { id, filter, channel });
    channel.send(
      jsonRpc.notify(McpProtocol.NOTIFICATION_SUBSCRIPTIONS_ACKNOWLEDGED, {
        notifications: McpSubscriptionHub.filterBody(filter),
        _meta: { [McpProtocol.META_SUBSCRIPTION_ID]: id },
      }),
    );
  }

  /**
   * 发布事件给所有匹配的订阅。
   * @param event 事件。
   * @returns 实际发送的通知条数。
   */
  public publish(event: McpSubscriptionEvent): number {
    let sent = 0;
    for (const subscription of this.active.values()) {
      if (!McpSubscriptionHub.matches(subscription.filter, event)) continue;
      subscription.channel.send(McpSubscriptionHub.notificationOf(subscription.id, event));
      sent += 1;
    }
    return sent;
  }

  /**
   * 优雅关闭一条订阅（先发完成响应，再关流）。
   * @param id subscriptionId（即原请求 id）。
   * @returns 是否命中并关闭。
   */
  public close(id: RequestId): boolean {
    const key = McpSubscriptionHub.keyOf(id);
    const subscription = this.active.get(key);
    if (subscription === undefined) return false;
    this.active.delete(key);
    subscription.channel.send(
      jsonRpc.response(id, {
        resultType: 'complete',
        _meta: { [McpProtocol.META_SUBSCRIPTION_ID]: id },
      }),
    );
    subscription.channel.close();
    return true;
  }

  /**
   * 关闭全部订阅（服务端停机）。
   * @returns 关闭的订阅数。
   */
  public closeAll(): number {
    const ids = [...this.active.values()].map((subscription) => subscription.id);
    for (const id of ids) this.close(id);
    return ids.length;
  }

  /**
   * 订阅 id → Map 键（数字 id 与字符串 id 不混淆）。
   * @param id 请求 id。
   * @returns Map 键。
   */
  private static keyOf(id: RequestId): string {
    return `${typeof id}:${String(id)}`;
  }

  /**
   * 规整过滤条件：只保留显式 true 的布尔位与非空 URI 列表。
   * @param requested 客户端请求。
   * @returns 规整后的过滤条件（ack 用同一份）。
   */
  private static normalizeFilter(requested: McpSubscriptionFilter): McpSubscriptionFilter {
    const uris = Array.isArray(requested.resourceSubscriptions)
      ? [
          ...new Set(
            requested.resourceSubscriptions.filter((uri) => typeof uri === 'string' && uri !== ''),
          ),
        ]
      : [];
    return {
      ...(requested.toolsListChanged === true ? { toolsListChanged: true } : {}),
      ...(requested.promptsListChanged === true ? { promptsListChanged: true } : {}),
      ...(requested.resourcesListChanged === true ? { resourcesListChanged: true } : {}),
      ...(uris.length > 0 ? { resourceSubscriptions: uris } : {}),
    };
  }

  /**
   * 过滤条件的线上形状（去掉 undefined，保留空对象）。
   * @param filter 规整后的过滤条件。
   * @returns 可 JSON 序列化的对象。
   */
  private static filterBody(filter: McpSubscriptionFilter): Record<string, unknown> {
    return {
      ...(filter.toolsListChanged === true ? { toolsListChanged: true } : {}),
      ...(filter.promptsListChanged === true ? { promptsListChanged: true } : {}),
      ...(filter.resourcesListChanged === true ? { resourcesListChanged: true } : {}),
      ...(filter.resourceSubscriptions !== undefined && filter.resourceSubscriptions.length > 0
        ? { resourceSubscriptions: [...filter.resourceSubscriptions] }
        : {}),
    };
  }

  /**
   * 事件是否命中某订阅。
   * @param filter 订阅过滤条件。
   * @param event 事件。
   * @returns 命中为 true。
   */
  private static matches(filter: McpSubscriptionFilter, event: McpSubscriptionEvent): boolean {
    switch (event.kind) {
      case 'toolsListChanged':
        return filter.toolsListChanged === true;
      case 'promptsListChanged':
        return filter.promptsListChanged === true;
      case 'resourcesListChanged':
        return filter.resourcesListChanged === true;
      case 'resourceUpdated':
        return (
          filter.resourceSubscriptions !== undefined &&
          filter.resourceSubscriptions.includes(event.uri)
        );
      default:
        return false;
    }
  }

  /**
   * 构造通知消息（带 subscriptionId）。
   * @param id subscriptionId。
   * @param event 事件。
   * @returns JSON-RPC 通知。
   */
  private static notificationOf(id: RequestId, event: McpSubscriptionEvent): RpcNotification {
    const meta = { [McpProtocol.META_SUBSCRIPTION_ID]: id };
    switch (event.kind) {
      case 'toolsListChanged':
        return jsonRpc.notify(McpProtocol.NOTIFICATION_TOOLS_LIST_CHANGED, { _meta: meta });
      case 'promptsListChanged':
        return jsonRpc.notify(McpProtocol.NOTIFICATION_PROMPTS_LIST_CHANGED, { _meta: meta });
      case 'resourcesListChanged':
        return jsonRpc.notify(McpProtocol.NOTIFICATION_RESOURCES_LIST_CHANGED, { _meta: meta });
      case 'resourceUpdated':
        return jsonRpc.notify(McpProtocol.NOTIFICATION_RESOURCES_UPDATED, {
          uri: event.uri,
          _meta: meta,
        });
    }
  }
}
