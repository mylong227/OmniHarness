/**
 * A2A 互操作服务端。
 *
 * 两条协议面并存（共用同一 `TaskHandler`）：
 * - **私有委托面**（U6 历史）：`capabilities.declare` / `task.delegate`。
 * - **A2A v1.0 互操作面**：`message/send`、`message/stream`、`tasks/get|cancel|subscribe|list`、
 *   `tasks/pushNotificationConfig/*`、`agent/getCard`、`agent/getAuthenticatedExtendedCard`。
 *
 * 协议语义在 `A2aV1Methods`（任务状态机 / 流事件 / push 配置）；本类只负责
 * JSON-RPC 收发、验签与错误码映射——认证边界因此只有一处实现。
 */
import type { RpcMessage } from '../server/core/jsonRpc.ts';
import { jsonRpc } from '../server/core/jsonRpc.ts';
import type { AgentIdentityPort } from '../ports/runtime/agentIdentity.ts';
import type {
  A2aAgentCard,
  A2aCapabilityDeclaration,
  A2aTransport,
  DelegateRequest,
} from './a2aProtocol.ts';
import {
  A2A_AGENT_GET_AUTHENTICATED_CARD,
  A2A_AGENT_GET_CARD,
  A2A_CAPABILITIES_DECLARE,
  A2A_ERROR_EXTENDED_CARD_NOT_CONFIGURED,
  A2A_ERROR_INVALID,
  A2A_ERROR_METHOD_NOT_FOUND,
  A2A_ERROR_TASK_NOT_CANCELABLE,
  A2A_ERROR_TASK_NOT_FOUND,
  A2A_ERROR_UNAUTHORIZED,
  A2A_ERROR_UNSUPPORTED_OPERATION,
  A2A_MESSAGE_SEND,
  A2A_MESSAGE_STREAM,
  A2A_PUSH_DELETE,
  A2A_PUSH_GET,
  A2A_PUSH_LIST,
  A2A_PUSH_SET,
  A2A_TASK_DELEGATE,
  A2A_TASKS_CANCEL,
  A2A_TASKS_GET,
  A2A_TASKS_LIST,
  A2A_TASKS_RESUBSCRIBE,
  A2A_TASKS_SUBSCRIBE,
} from './a2aProtocol.ts';
import { A2aProtocolError } from './a2aProtocolError.ts';
import { A2aTaskStore } from './a2aTaskStore.ts';
import { A2aPushNotifications } from './a2aPushNotifications.ts';
import { A2aV1Methods } from './a2aV1Methods.ts';
import type { TaskHandler } from './a2aTaskHandler.ts';

export type { TaskHandler } from './a2aTaskHandler.ts';

/** 断言头的 `AgentAssertion ` 前缀（`AgentIdentityPort.authorizationHeader()` 的直接产物形态）。 */
const ASSERTION_PREFIX = 'AgentAssertion ';

/** 需要 A2A v1 验签的方法集合（`agent/getCard` 是公开发现面，不要求签名）。 */
const V1_PROTECTED: ReadonlySet<string> = new Set<string>([
  A2A_MESSAGE_SEND,
  A2A_MESSAGE_STREAM,
  A2A_TASKS_GET,
  A2A_TASKS_CANCEL,
  A2A_TASKS_SUBSCRIBE,
  A2A_TASKS_RESUBSCRIBE,
  A2A_TASKS_LIST,
  A2A_PUSH_SET,
  A2A_PUSH_GET,
  A2A_PUSH_LIST,
  A2A_PUSH_DELETE,
  A2A_AGENT_GET_AUTHENTICATED_CARD,
]);

/** 流式方法集合（同一 JSON-RPC id 的多条响应）。 */
const STREAMING_METHODS: ReadonlySet<string> = new Set<string>([
  A2A_MESSAGE_STREAM,
  A2A_TASKS_SUBSCRIBE,
  A2A_TASKS_RESUBSCRIBE,
]);

/**
 * A2A 服务端。
 */
export class A2aServer {
  /** 注入的任务委托处理器（未配置时 v1/私有面都 fail-closed 报错）。 */
  private handler: TaskHandler | undefined;
  /** 已登记的对端能力声明表（agentId → 声明）。 */
  private readonly declarations = new Map<string, A2aCapabilityDeclaration>();
  /** A2A v1.0 AgentCard（可选；未设置时取卡方法 fail-closed）。 */
  private card: A2aAgentCard | undefined;
  /** 任务表（状态机 + 流事件）。 */
  private readonly tasks = new A2aTaskStore();
  /** push notification 配置与投递。 */
  private readonly push = new A2aPushNotifications();
  /** v1.0 协议语义实现。 */
  private readonly v1: A2aV1Methods;

  /**
   * @param transport 底层传输端口（监听入站 JSON-RPC 并回写响应）。
   * @param identity 可选的 Agent 身份端口；提供时对受保护请求强制 fail-closed 验签。
   */
  public constructor(
    private readonly transport: A2aTransport,
    private readonly identity?: AgentIdentityPort,
  ) {
    this.v1 = new A2aV1Methods({
      tasks: this.tasks,
      push: this.push,
      handler: () => this.handler,
    });
    this.transport.onMessage((message) => void this.onMessage(message));
  }

  /**
   * 注入任务处理器（本地执行委托）。
   * @param handler 任务委托处理器。
   * @returns 无返回值。
   */
  public setTaskHandler(handler: TaskHandler): void {
    this.handler = handler;
  }

  /**
   * 设置 A2A v1.0 AgentCard（供取卡方法与 well-known 路由返回）。
   * @param card AgentCard。
   * @returns 无返回值。
   */
  public setAgentCard(card: A2aAgentCard): void {
    this.card = card;
  }

  /**
   * 查询已登记的对端能力声明。
   * @param agentId 对端 agent 标识。
   * @returns 该对端最近一次声明；从未登记时返回 undefined。
   */
  public getDeclaration(agentId: string): A2aCapabilityDeclaration | undefined {
    return this.declarations.get(agentId);
  }

  /**
   * 全部已登记声明。
   * @returns 所有对端能力声明的快照（数组拷贝，与内部表解耦）。
   */
  public get declarationsList(): readonly A2aCapabilityDeclaration[] {
    return [...this.declarations.values()];
  }

  /**
   * 处理入站 JSON-RPC 请求：流式方法走多响应通道，其余方法单响应；
   * 错误按 `A2aProtocolError.code`（缺省 INVALID / UNAUTHORIZED）映射。
   * @param message 入站 JSON-RPC 消息（非请求/通知则忽略）。
   * @returns 无返回值。
   */
  private async onMessage(message: RpcMessage): Promise<void> {
    if (!('method' in message)) return; // 响应，忽略
    const id = 'id' in message ? message.id : null;
    const params = (message as { readonly params?: unknown }).params;
    try {
      if (STREAMING_METHODS.has(message.method)) {
        if (id === null) throw new A2aProtocolError('流式方法必须带 id', A2A_ERROR_INVALID);
        this.assertV1(params);
        await this.handleStream(message.method, params, id);
        return;
      }
      const result = await this.dispatch(message.method, params);
      if (id !== null) this.transport.send(jsonRpc.response(id, result));
    } catch (error) {
      if (id === null) return;
      const mapped = A2aServer.errorOf(error);
      this.transport.send(jsonRpc.errorResponse(id, mapped.code, mapped.message));
    }
  }

  /**
   * 处理流式方法：把每次 respond 编码为同一 id 的 JSON-RPC 响应（HTTP 传输落为 SSE）。
   * @param method 流式方法名。
   * @param params 请求参数。
   * @param id JSON-RPC 请求 id。
   * @returns 无返回值。
   */
  private async handleStream(method: string, params: unknown, id: number | string): Promise<void> {
    const respond = (payload: unknown): void => {
      this.transport.send(jsonRpc.response(id, payload));
    };
    if (method === A2A_MESSAGE_STREAM) {
      await this.v1.stream(params, respond);
      return;
    }
    await this.v1.subscribe(params, respond);
  }

  /**
   * 校验 A2A v1 请求的签名（配置了身份时强制）。
   *
   * 断言位置兼容两种：顶层 `params.assertion`（传输层把 HTTP `Authorization` 原文放入），
   * 或 `params.message.metadata.assertion`（A2A 消息元数据形态）。
   * @param params 请求参数。
   * @returns 无返回值。
   */
  private assertV1(params: unknown): void {
    if (this.identity === undefined) {
      return;
    }
    const payload = params as {
      readonly assertion?: unknown;
      readonly message?: { readonly metadata?: { readonly assertion?: unknown } };
    };
    const raw =
      typeof payload.assertion === 'string'
        ? payload.assertion
        : typeof payload.message?.metadata?.assertion === 'string'
          ? payload.message.metadata.assertion
          : undefined;
    if (raw === undefined) {
      throw new A2aProtocolError('UNAUTHORIZED: 缺失 v1 请求签名', A2A_ERROR_UNAUTHORIZED);
    }
    if (!this.verifyAssertion(raw)) {
      throw new A2aProtocolError('UNAUTHORIZED: v1 请求验签失败', A2A_ERROR_UNAUTHORIZED);
    }
  }

  /**
   * fail-closed 验签：未配置身份即放行（零破坏）；配置了身份则必须验过。
   * 接受两种原文形态——裸签名信封，或 HTTP `Authorization` 头形态
   * （`AgentAssertion <envelope>`，即 `AgentIdentityPort.authorizationHeader()` 的直接产物）。
   * @param assertion 断言原文（可带 `AgentAssertion ` 前缀）；undefined 视为缺失。
   * @returns 验签通过为 true；缺失 / 格式非法 / 验签失败一律 false（绝不抛错谎称通过）。
   */
  private verifyAssertion(assertion: string | undefined): boolean {
    if (this.identity === undefined) {
      return true;
    }
    if (assertion === undefined) {
      return false;
    }
    const payload = assertion.startsWith(ASSERTION_PREFIX)
      ? assertion.slice(ASSERTION_PREFIX.length)
      : assertion;
    return this.identity.verifyAssertion(payload) !== null;
  }

  /**
   * 按方法名分发（私有委托面 → v1 互操作面）。
   * @param method JSON-RPC 方法名。
   * @param params 方法参数。
   * @returns 方法执行结果。
   */
  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === A2A_CAPABILITIES_DECLARE) {
      const decl = params as A2aCapabilityDeclaration;
      // fail-closed：配置了身份就必须验签，缺失或验不过即拒。
      if (this.identity !== undefined && decl.assertion === undefined) {
        throw new A2aProtocolError('UNAUTHORIZED: 缺失能力声明签名', A2A_ERROR_UNAUTHORIZED);
      }
      if (!this.verifyAssertion(decl.assertion)) {
        throw new A2aProtocolError('UNAUTHORIZED: 能力声明验签失败', A2A_ERROR_UNAUTHORIZED);
      }
      this.declarations.set(decl.agentId, decl);
      return { accepted: true };
    }
    if (method === A2A_TASK_DELEGATE) {
      if (this.handler === undefined) {
        throw new A2aProtocolError('未配置任务处理器', A2A_ERROR_UNSUPPORTED_OPERATION);
      }
      const req = params as DelegateRequest;
      if (this.identity !== undefined && req.assertion === undefined) {
        throw new A2aProtocolError('UNAUTHORIZED: 缺失委托请求签名', A2A_ERROR_UNAUTHORIZED);
      }
      if (!this.verifyAssertion(req.assertion)) {
        throw new A2aProtocolError('UNAUTHORIZED: 委托请求验签失败', A2A_ERROR_UNAUTHORIZED);
      }
      return await this.handler.handle(req);
    }
    if (V1_PROTECTED.has(method)) this.assertV1(params);
    switch (method) {
      case A2A_MESSAGE_SEND:
        return await this.v1.send(params);
      case A2A_TASKS_GET:
        return this.v1.get(params);
      case A2A_TASKS_CANCEL:
        return this.v1.cancel(params);
      case A2A_TASKS_LIST:
        return this.v1.list(params);
      case A2A_PUSH_SET:
        return this.v1.pushSet(params);
      case A2A_PUSH_GET:
        return this.v1.pushGet(params);
      case A2A_PUSH_LIST:
        return this.v1.pushList(params);
      case A2A_PUSH_DELETE:
        return this.v1.pushDelete(params);
      case A2A_AGENT_GET_CARD:
        if (this.card === undefined) {
          throw new A2aProtocolError('未配置 AgentCard', A2A_ERROR_EXTENDED_CARD_NOT_CONFIGURED);
        }
        return this.card;
      case A2A_AGENT_GET_AUTHENTICATED_CARD:
        return this.authenticatedCard();
      default:
        throw new A2aProtocolError(`未知方法: ${method}`, A2A_ERROR_METHOD_NOT_FOUND);
    }
  }

  /**
   * 取认证后的扩展 AgentCard（必须声明 `capabilities.extendedAgentCard` 且配置了身份）。
   * @returns 扩展 AgentCard。
   */
  private authenticatedCard(): A2aAgentCard {
    if (this.card === undefined) {
      throw new A2aProtocolError('未配置 AgentCard', A2A_ERROR_EXTENDED_CARD_NOT_CONFIGURED);
    }
    if (this.identity === undefined) {
      throw new A2aProtocolError(
        'UNAUTHORIZED: 未配置身份，无法提供认证扩展卡',
        A2A_ERROR_UNAUTHORIZED,
      );
    }
    if (this.card.capabilities?.extendedAgentCard !== true) {
      throw new A2aProtocolError(
        '未声明 capabilities.extendedAgentCard',
        A2A_ERROR_EXTENDED_CARD_NOT_CONFIGURED,
      );
    }
    return this.card;
  }

  /**
   * 异常 → JSON-RPC 错误码（协议错误透传；UNAUTHORIZED 归一；其余按非法参数）。
   * @param error 异常。
   * @returns 错误码与可读消息。
   */
  private static errorOf(error: unknown): { readonly code: number; readonly message: string } {
    if (error instanceof A2aProtocolError) {
      return { code: error.code, message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNAUTHORIZED')) {
      return { code: A2A_ERROR_UNAUTHORIZED, message };
    }
    if (message.includes('未知任务')) {
      return { code: A2A_ERROR_TASK_NOT_FOUND, message };
    }
    if (message.includes('不可取消')) {
      return { code: A2A_ERROR_TASK_NOT_CANCELABLE, message };
    }
    return { code: A2A_ERROR_INVALID, message };
  }
}

export { A2A_ERROR_METHOD_NOT_FOUND };
