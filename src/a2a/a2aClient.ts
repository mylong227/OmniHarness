/**
 * A2A 互操作客户端（U6）。
 *
 * 通过可插拔 `A2aTransport` 向对端 agent 声明能力、委托任务并回收结果。
 * 请求/响应经 JSON-RPC id 关联；可选注入 `AgentIdentityPort` 对委托请求签名，
 * 由对端 fail-closed 验签。
 *
 * 零依赖（仅 server/jsonRpc + a2aProtocol）。
 */
import type { RpcMessage } from '../server/jsonRpc.js';
import { jsonRpc } from '../server/jsonRpc.js';
import type { AgentIdentityPort } from '../ports/agentIdentity.js';
import type {
  A2aCapability,
  A2aCapabilityDeclaration,
  A2aTransport,
  DelegateRequest,
  DelegateResult,
} from './a2aProtocol.js';
import { A2A_CAPABILITIES_DECLARE, A2A_TASK_DELEGATE } from './a2aProtocol.js';

/** 委托/声明调用超时（ms）。 */
const DEFAULT_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A2A 客户端：连接一个对端 agent（server）。
 */
export class A2aClient {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();

  public constructor(
    private readonly transport: A2aTransport,
    private readonly identity?: AgentIdentityPort,
  ) {
    this.transport.onMessage((m) => this.onMessage(m));
  }

  /** 向对端声明本端能力（可选签名）。 */
  public async declareCapabilities(
    agentId: string,
    capabilities: readonly A2aCapability[],
  ): Promise<void> {
    const decl: A2aCapabilityDeclaration = {
      agentId,
      capabilities,
      ...(this.identity !== undefined
        ? { assertion: this.identity.authorizationHeader(agentId) }
        : {}),
    };
    await this.call(A2A_CAPABILITIES_DECLARE, decl);
  }

  /** 委托一个任务给对端，返回执行结果（fail-closed：验签/超时/异常均抛错）。 */
  public async delegateTask(request: DelegateRequest): Promise<DelegateResult> {
    const req = { ...request };
    if (this.identity !== undefined) {
      req.assertion = this.identity.authorizationHeader(request.taskId);
    }
    const result = await this.call(A2A_TASK_DELEGATE, req);
    return result as DelegateResult;
  }

  /** 关闭底层传输。 */
  public close(): void {
    this.transport.close?.();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('A2aClient 已关闭'));
    }
    this.pending.clear();
  }

  private onMessage(message: RpcMessage): void {
    if (!('id' in message)) return; // 通知，忽略
    const id = message.id;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if ('error' in message && message.error !== undefined) {
      pending.reject(new Error(`A2A 远端错误 [${message.error.code}] ${message.error.message}`));
      return;
    }
    if ('result' in message) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error('A2A 响应缺少 result/error'));
  }

  private call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`A2A 调用超时: ${method}`));
      }, DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(jsonRpc.request(id, method, params as Record<string, unknown>));
    });
  }
}
