/**
 * A2A 互操作服务端（U6）。
 *
 * 在可插拔 `A2aTransport` 上监听并分发 A2A 方法：
 * - `capabilities.declare`：登记对端能力声明（可选验签）。
 * - `task.delegate`：转交注入的 `TaskHandler` 执行（如本地起一个子 agent），
 *   回传 `DelegateResult`。未配置 handler 则 fail-closed 报错。
 *
 * 零依赖。
 */
import type { RpcMessage } from '../server/jsonRpc.js';
import { jsonRpc } from '../server/jsonRpc.js';
import type { AgentIdentityPort } from '../ports/agentIdentity.js';
import type {
  A2aCapabilityDeclaration,
  A2aTransport,
  DelegateRequest,
  DelegateResult,
} from './a2aProtocol.js';
import {
  A2A_CAPABILITIES_DECLARE,
  A2A_ERROR_INVALID,
  A2A_ERROR_METHOD_NOT_FOUND,
  A2A_ERROR_UNAUTHORIZED,
  A2A_TASK_DELEGATE,
} from './a2aProtocol.js';

/** 任务委托处理器（由调用方注入：通常起一个本地子 agent 跑任务）。 */
export interface TaskHandler {
  handle(request: DelegateRequest): Promise<DelegateResult>;
}

/**
 * A2A 服务端。
 */
export class A2aServer {
  private handler: TaskHandler | undefined;
  private readonly declarations = new Map<string, A2aCapabilityDeclaration>();

  public constructor(
    private readonly transport: A2aTransport,
    private readonly identity?: AgentIdentityPort,
  ) {
    this.transport.onMessage((m) => void this.onMessage(m));
  }

  /** 注入任务处理器（本地执行委托）。 */
  public setTaskHandler(handler: TaskHandler): void {
    this.handler = handler;
  }

  /** 查询已登记的对端能力声明。 */
  public getDeclaration(agentId: string): A2aCapabilityDeclaration | undefined {
    return this.declarations.get(agentId);
  }

  /** 全部已登记声明。 */
  public get declarationsList(): readonly A2aCapabilityDeclaration[] {
    return [...this.declarations.values()];
  }

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

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === A2A_CAPABILITIES_DECLARE) {
      const decl = params as A2aCapabilityDeclaration;
      if (this.identity !== undefined) {
        // fail-closed：配置了身份就必须验签，缺失或验不过即拒。
        if (decl.assertion === undefined) throw new Error('UNAUTHORIZED: 缺失能力声明签名');
        const claims = this.identity.verifyAssertion(decl.assertion);
        if (claims === null) throw new Error('UNAUTHORIZED: 能力声明验签失败');
      }
      this.declarations.set(decl.agentId, decl);
      return { accepted: true };
    }
    if (method === A2A_TASK_DELEGATE) {
      if (this.handler === undefined) throw new Error('未配置任务处理器');
      const req = params as DelegateRequest;
      if (this.identity !== undefined) {
        if (req.assertion === undefined) throw new Error('UNAUTHORIZED: 缺失委托请求签名');
        const claims = this.identity.verifyAssertion(req.assertion);
        if (claims === null) throw new Error('UNAUTHORIZED: 委托请求验签失败');
      }
      return await this.handler.handle(req);
    }
    throw new Error(`未知方法: ${method}`);
  }
}

export { A2A_ERROR_METHOD_NOT_FOUND };
