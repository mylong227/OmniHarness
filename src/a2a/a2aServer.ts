/**
 * A2A 互操作服务端（U6）。
 *
 * 在可插拔 `A2aTransport` 上监听并分发 A2A 方法：
 * - `capabilities.declare`：登记对端能力声明（可选验签）。
 * - `task.delegate`：转交注入的 `TaskHandler` 执行（如本地起一个子 agent），
 *   回传 `DelegateResult`。未配置 handler 则 fail-closed 报错。
 *
 * 无第三方依赖。
 */
import type { RpcMessage } from '../server/core/jsonRpc.ts';
import { jsonRpc } from '../server/core/jsonRpc.ts';
import type { AgentIdentityPort } from '../ports/runtime/agentIdentity.ts';
import type {
  A2aAgentCard,
  A2aCapabilityDeclaration,
  A2aTask,
  A2aTransport,
  DelegateRequest,
  DelegateResult,
} from './a2aProtocol.ts';
import {
  A2A_AGENT_GET_CARD,
  A2A_CAPABILITIES_DECLARE,
  A2A_ERROR_INVALID,
  A2A_ERROR_METHOD_NOT_FOUND,
  A2A_ERROR_UNAUTHORIZED,
  A2A_MESSAGE_SEND,
  A2A_TASK_DELEGATE,
  A2A_TASKS_GET,
} from './a2aProtocol.ts';

/** 断言头的 `AgentAssertion ` 前缀（`AgentIdentityPort.authorizationHeader()` 的直接产物形态）。 */
const ASSERTION_PREFIX = 'AgentAssertion ';

/** 任务委托处理器（由调用方注入：通常起一个本地子 agent 跑任务）。 */
export interface TaskHandler {
  /**
   * 执行一次委托任务。
   * @param request 委托请求（taskId / 输入 / 签名断言）。
   * @returns 任务执行结果。
   */
  handle(request: DelegateRequest): Promise<DelegateResult>;
}

/**
 * A2A 服务端。
 */
export class A2aServer {
  /** 注入的任务委托处理器（未配置时 task.delegate fail-closed 报错）。 */
  private handler: TaskHandler | undefined;
  /** 已登记的对端能力声明表（agentId → 声明）。 */
  private readonly declarations = new Map<string, A2aCapabilityDeclaration>();
  /** A2A v1.0 任务表（taskId → Task），供 `tasks/get` 查询。 */
  private readonly tasks = new Map<string, A2aTask>();
  /** A2A v1.0 AgentCard（可选；未设置时 `agent/getCard` fail-closed）。 */
  private card: A2aAgentCard | undefined;

  /**
   * @param transport 底层传输端口（监听入站 JSON-RPC 并回写响应）。
   * @param identity 可选的 Agent 身份端口；提供时对所有入站请求强制 fail-closed 验签。
   */
  public constructor(
    private readonly transport: A2aTransport,
    private readonly identity?: AgentIdentityPort,
  ) {
    this.transport.onMessage((m) => void this.onMessage(m));
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
   * 设置 A2A v1.0 AgentCard（供 `agent/getCard` 返回）。
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
   * 处理入站 JSON-RPC 请求：dispatch 后按 id 回写响应；错误映射为
   * UNAUTHORIZED / INVALID 错误响应（通知类无 id 时只吞错不回写）。
   * @param message 入站 JSON-RPC 消息（非请求/通知则忽略）。
   
   * @returns 无返回值。
   */
  private async onMessage(message: RpcMessage): Promise<void> {
    if (!('method' in message)) return; // 响应，忽略
    const id = 'id' in message ? message.id : null;
    try {
      const result = await this.dispatch(message.method, (message as { params?: unknown }).params);
      if (id !== null) this.transport.send(jsonRpc.response(id, result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (id !== null) {
        const code = msg.includes('UNAUTHORIZED') ? A2A_ERROR_UNAUTHORIZED : A2A_ERROR_INVALID;
        this.transport.send(jsonRpc.errorResponse(id, code, msg));
      }
    }
  }

  /**
   * 校验 A2A v1 请求的签名（配置了身份时强制）。
   *
   * 断言位置兼容两种：顶层 `params.assertion`（传输层把 HTTP `Authorization` 原文放入），
   * 或 `params.message.metadata.assertion`（A2A 消息元数据形态）。
   * @param params 请求参数。
   * @returns 无返回值；缺失/验签失败时抛 `UNAUTHORIZED`。
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
      throw new Error('UNAUTHORIZED: 缺失 v1 请求签名');
    }
    if (!this.verifyAssertion(raw)) {
      throw new Error('UNAUTHORIZED: v1 请求验签失败');
    }
  }

  /**
   * fail-closed 验签：未配置身份即放行（零破坏）；配置了身份则必须验过。
   * 接受两种原文形态——裸签名信封，或 HTTP `Authorization` 头形态
   * （`AgentAssertion <envelope>`，即 `AgentIdentityPort.authorizationHeader()` 的直接产物）。
   * 此前只按裸信封解码，导致**真实 Ed25519 身份下客户端发出的断言恒解析失败**
   * （仅自造桩身份因自带去前缀逻辑而侥幸通过）——E2 跨进程实测才暴露。
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
   * 按 A2A 方法名分发：capabilities.declare 登记（可选验签）、task.delegate 转交 handler。
   * @param method JSON-RPC 方法名。
   * @param params 方法参数（声明或委托请求）。
   * @returns 方法执行结果（如 { accepted: true } 或 DelegateResult）；未知方法、验签失败或缺 handler 时抛错。
   */
  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === A2A_CAPABILITIES_DECLARE) {
      const decl = params as A2aCapabilityDeclaration;
      // fail-closed：配置了身份就必须验签，缺失或验不过即拒。
      if (this.identity !== undefined && decl.assertion === undefined) {
        throw new Error('UNAUTHORIZED: 缺失能力声明签名');
      }
      if (!this.verifyAssertion(decl.assertion)) throw new Error('UNAUTHORIZED: 能力声明验签失败');
      this.declarations.set(decl.agentId, decl);
      return { accepted: true };
    }
    if (method === A2A_TASK_DELEGATE) {
      if (this.handler === undefined) throw new Error('未配置任务处理器');
      const req = params as DelegateRequest;
      if (this.identity !== undefined && req.assertion === undefined) {
        throw new Error('UNAUTHORIZED: 缺失委托请求签名');
      }
      if (!this.verifyAssertion(req.assertion)) throw new Error('UNAUTHORIZED: 委托请求验签失败');
      return await this.handler.handle(req);
    }
    // A2A v1.0 最小互操作面：message/send / tasks/get / agent/getCard。
    // 2026-10-21：v1 的 message/send 与 tasks/get 此前**完全绕过验签**（配置了身份也能免签
    // 委托/读任务），与类注释「对所有入站请求强制验签」相反。现在按同一口径校验：
    // 断言可放在 `params.assertion` 或 `message.metadata.assertion`（HTTP 头形态由传输层
    // 直接透传为 `params.assertion` 即可）；agent/getCard 是公开能力声明，不要求签名。
    if (method === A2A_MESSAGE_SEND) {
      this.assertV1(params);
      return await this.handleV1Message(params);
    }
    if (method === A2A_TASKS_GET) {
      this.assertV1(params);
      const id = (params as { id?: unknown }).id;
      const task = typeof id === 'string' ? this.tasks.get(id) : undefined;
      if (task === undefined) throw new Error(`未知任务: ${String(id)}`);
      return task;
    }
    if (method === A2A_AGENT_GET_CARD) {
      if (this.card === undefined) throw new Error('未配置 AgentCard');
      return this.card;
    }
    throw new Error(`未知方法: ${method}`);
  }

  /**
   * 处理 A2A v1.0 `message/send`：把消息里的 text parts 交给 TaskHandler，返回 Task。
   *
   * 兼容口径：不强制要求 `kind`（v1.0 已删除该判别字段）；`contextId` 原样回传；
   * 没有文本 part 时 fail-closed（不凭空造任务）。
   * @param params `{ message: { parts: [{type:'text', text}], messageId? }, contextId? }`
   * @returns 完成的 Task（成功带 artifacts，失败带 error）。
   */
  private async handleV1Message(params: unknown): Promise<A2aTask> {
    if (this.handler === undefined) throw new Error('未配置任务处理器');
    const payload = params as {
      readonly message?: {
        readonly parts?: readonly { readonly type?: string; readonly text?: string }[];
        readonly messageId?: string;
      };
      readonly contextId?: string;
    };
    const text = (payload.message?.parts ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();
    if (text === '') throw new Error('message/send 缺少文本 part');
    const id =
      payload.message?.messageId ?? `task-${String(Date.now())}-${String(this.tasks.size)}`;
    const contextId = payload.contextId;
    const result = await this.handler.handle({
      taskId: id,
      task: text,
      ...(contextId !== undefined ? { parentSessionId: contextId } : {}),
    });
    const task: A2aTask = {
      id,
      ...(contextId !== undefined ? { contextId } : {}),
      status: { state: result.ok ? 'completed' : 'failed', timestamp: new Date().toISOString() },
      ...(result.ok
        ? {
            artifacts: [
              {
                artifactId: `${id}-output`,
                parts: [{ type: 'text' as const, text: result.output }],
              },
            ],
          }
        : { error: result.error ?? '任务失败' }),
    };
    this.tasks.set(id, task);
    return task;
  }
}

export { A2A_ERROR_METHOD_NOT_FOUND };
