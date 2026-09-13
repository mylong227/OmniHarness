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

/** 挂起请求的关联记录（按 JSON-RPC id 索引）。 */
interface Pending {
  /** 成功回包时的 resolver。 */
  resolve: (value: unknown) => void;
  /** 远端错误/超时/关闭时的 rejector。 */
  reject: (reason: Error) => void;
  /** 超时定时器（DEFAULT_TIMEOUT_MS 后触发 reject）。 */
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A2A 客户端：连接一个对端 agent（server）。
 */
export class A2aClient {
  /** 下一个 JSON-RPC 请求 id（自增）。 */
  private nextId = 1;
  /** 挂起请求表：JSON-RPC id → Pending（响应到达或超时时移除）。 */
  private readonly pending = new Map<number | string, Pending>();

  /**
   * @param transport 底层传输端口（负责实际收发 JSON-RPC 消息）。
   * @param identity 可选的 Agent 身份端口；提供时对声明/委托请求附加签名断言。
   */
  public constructor(
    private readonly transport: A2aTransport,
    private readonly identity?: AgentIdentityPort,
  ) {
    this.transport.onMessage((m) => this.onMessage(m));
  }

  /**
   * 向对端声明本端能力（可选签名）。
   * @param agentId 本端 agent 标识。
   * @param capabilities 本端可被委托的能力清单。
   
 * @returns 无返回值。
*/
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

  /**
   * 委托一个任务给对端，返回执行结果（fail-closed：验签/超时/异常均抛错）。
   * @param request 委托请求（taskId / 输入等；注入 identity 时自动附加 assertion）。
   * @returns 对端执行结果。
   */
  public async delegateTask(request: DelegateRequest): Promise<DelegateResult> {
    const req = { ...request };
    if (this.identity !== undefined) {
      req.assertion = this.identity.authorizationHeader(request.taskId);
    }
    const result = await this.call(A2A_TASK_DELEGATE, req);
    return result as DelegateResult;
  }

  /** 关闭底层传输。
   * @returns 无返回值。
   */
  public close(): void {
    this.transport.close?.();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('A2aClient 已关闭'));
    }
    this.pending.clear();
  }

  /**
   * 处理传输层入站消息：按 id 匹配挂起请求并兑现/拒绝其 Promise（通知与未知 id 忽略）。
   * @param message 入站 JSON-RPC 消息。
   
 * @returns 无返回值。
*/
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

  /**
   * 发起一次 JSON-RPC 调用：登记挂起请求并经传输发送，超时（DEFAULT_TIMEOUT_MS）reject。
   * @param method JSON-RPC 方法名。
   * @param params 方法参数。
   * @returns 对端 result 载荷（由 onMessage 兑现）。
   */
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
