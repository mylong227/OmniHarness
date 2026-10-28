import type { RpcMessage } from '../server/core/jsonRpc.ts';
import { jsonRpc } from '../server/core/jsonRpc.ts';
import { API_VERSION } from '../version.ts';
import { PendingRequests } from '../util/concurrency/pendingRequests.ts';
import type { EventPort } from '../ports/runtime/eventPort.ts';
import type { ApprovalPort, ApprovalDecision } from '../ports/runtime/approval.ts';
import type { ApprovalRequest } from '../ports/runtime/approval.ts';
import { MUTATING_TOOL_NAMES } from '../ports/tool/toolNames.ts';
import { AcpAuthentication } from './acpAuthentication.ts';
import type { AcpAuthenticator } from './acpAuthenticator.ts';
import type { AcpSessionFactory } from './agentAcpSession.ts';
import { AcpEventMapper } from './acpEventMapper.ts';
import { AcpRequestError } from './acpRequestError.ts';
import { AcpSessionLifecycle } from './acpSessionLifecycle.ts';
import { AcpSessionRegistry } from './acpSessionRegistry.ts';
import type { AcpSessionState } from './acpSessionRegistry.ts';
import { AcpValidation } from './acpValidation.ts';
import type { AcpTransport } from './acpStdioTransport.ts';
import type {
  AcpAgentCapabilities,
  AcpContentBlock,
  AcpImplementation,
  AcpPermissionMode,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPromptResponse,
  AcpSessionUpdate,
} from './acpProtocol.ts';
import {
  ACP_ERROR_INTERNAL,
  ACP_ERROR_INVALID_PARAMS,
  ACP_ERROR_INVALID_REQUEST,
  ACP_ERROR_METHOD_NOT_FOUND,
  ACP_METHOD_AUTHENTICATE,
  ACP_METHOD_INITIALIZE,
  ACP_METHOD_LOGOUT,
  ACP_METHOD_REQUEST_PERMISSION,
  ACP_METHOD_SESSION_CANCEL,
  ACP_METHOD_SESSION_CLOSE,
  ACP_METHOD_SESSION_LIST,
  ACP_METHOD_SESSION_LOAD,
  ACP_METHOD_SESSION_NEW,
  ACP_METHOD_SESSION_PROMPT,
  ACP_METHOD_SESSION_RESUME,
  ACP_METHOD_SESSION_UPDATE,
  ACP_PROTOCOL_VERSION,
} from './acpProtocol.ts';

/** 默认权限请求等待上限（毫秒）：超时按拒绝兑现（fail-closed）。 */
const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

/** 写类工具集合（与 ToolGate 同源：权限只问这些工具）。 */
const ACP_MUTATING: ReadonlySet<string> = new Set<string>(MUTATING_TOOL_NAMES);

/** AcpServer 依赖。 */
export interface AcpServerOptions {
  /** 传输（stdio / 内存替身）。 */
  readonly transport: AcpTransport;
  /** 会话运行时工厂（CLI 装配真实 Agent）。 */
  readonly sessionFactory: AcpSessionFactory;
  /** 权限策略（缺省 client：写类工具问 Client）。 */
  readonly permissionMode?: AcpPermissionMode;
  /** 权限请求等待上限（毫秒；0 = 不限时）。 */
  readonly permissionTimeoutMs?: number;
  /** 上报给 Client 的实现信息。 */
  readonly agentInfo?: AcpImplementation;
  /** 认证端口（缺省不注入 = 不提供认证方式，authenticate 一律拒绝）。 */
  readonly authenticator?: AcpAuthenticator;
  /** 是否要求先 authenticate 才能创建会话 / 跑 prompt / 列出会话（默认 false，保持兼容）。 */
  readonly requireAuth?: boolean;
}

/** 归一化后的服务端依赖（缺省值在构造期一次填好，避免每个方法都做 `??`）。 */
interface NormalizedAcpServerOptions {
  /** 传输。 */
  readonly transport: AcpTransport;
  /** 会话工厂。 */
  readonly sessionFactory: AcpSessionFactory;
  /** 权限策略。 */
  readonly permissionMode: AcpPermissionMode;
  /** 权限等待上限（毫秒）。 */
  readonly permissionTimeoutMs: number;
  /** 实现信息。 */
  readonly agentInfo: AcpImplementation;
}

/**
 * ACP v1 Agent 服务端（JSON-RPC over stdio）。
 *
 * 覆盖：initialize（版本/能力/认证方式）、authenticate/logout、
 * session/new|load|list|resume|close|prompt、session/cancel、
 * session/update（文本/思考/工具调用/计划）、session/request_permission（权限请求/响应）。
 * 认证与会话生命周期分别见 `AcpAuthentication` / `AcpSessionLifecycle`。
 */
export class AcpServer {
  /** 归一化依赖。 */
  private readonly deps: NormalizedAcpServerOptions;
  /** 认证状态。 */
  private readonly auth: AcpAuthentication;
  /** 活跃会话表与生命周期簿记。 */
  private readonly registry = new AcpSessionRegistry();
  /** 会话生命周期方法集（new/load/list/resume/close）。 */
  private readonly lifecycle: AcpSessionLifecycle;
  /** 在途的 Client 请求（权限请求 id → 结果）。 */
  private readonly pending = new PendingRequests<number, AcpPermissionOutcome>();
  /** `run()` 的唤醒回调（`finish()` 兑现一次）。 */
  private finishRun: (() => void) | undefined;
  /** `run()` 的等待 Promise（重复 run 复用同一份，避免重复注册 onClose）。 */
  private runPromise: Promise<void> | undefined;
  /** 会话级可变状态（能力/请求 id/关闭位合并，避免字段数膨胀）。 */
  private readonly state: {
    clientCapabilities: Record<string, unknown>;
    nextRequestId: number;
    closed: boolean;
  } = {
    clientCapabilities: {},
    nextRequestId: 1,
    closed: false,
  };

  /**
   * @param options 传输、会话工厂、权限策略与可选认证端口。
   */
  public constructor(options: AcpServerOptions) {
    this.deps = {
      transport: options.transport,
      sessionFactory: options.sessionFactory,
      permissionMode: options.permissionMode ?? 'client',
      permissionTimeoutMs: options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
      agentInfo: options.agentInfo ?? {
        name: 'omniharness',
        title: 'OmniHarness',
        version: API_VERSION,
      },
    };
    this.auth = new AcpAuthentication(
      options.authenticator,
      options.requireAuth ?? false,
      this.registry,
    );
    this.lifecycle = new AcpSessionLifecycle({
      registry: this.registry,
      auth: this.auth,
      openSession: (sessionId, cwd) => this.openSession(sessionId, cwd),
      sendUpdate: (sessionId, update) => this.sendUpdate(sessionId, update),
      settlePermissions: (permissionIds) => this.settlePermissions(permissionIds),
    });
  }

  /**
   * 启动服务并等待传输关闭（stdio EOF / 进程断开）。
   *
   * **不悬挂**（审计 #12）：传输没有 `onClose` 时（内存替身 / 自定义传输）不再让
   * Promise 永远悬着——`close()` 会兑现同一份收尾。run 之后再 close、或 close 之后
   * 再 run 都立即返回（收尾只做一次）。
   * @returns 传输关闭或 `close()` 时 resolve。
   */
  public async run(): Promise<void> {
    this.deps.transport.onMessage((message) => void this.onMessage(message));
    if (this.state.closed) return;
    if (this.runPromise === undefined) {
      this.runPromise = new Promise<void>((resolve) => {
        this.finishRun = resolve;
      });
      this.deps.transport.onClose?.(() => this.finish());
    }
    await this.runPromise;
  }

  /**
   * 关闭服务（主动断开传输并收尾挂起请求与活跃会话）。
   * @returns 无返回值。
   */
  public close(): void {
    this.finish();
    this.deps.transport.close?.();
  }

  /**
   * 收尾一次（关闭位 / 挂起权限请求 / 活跃会话 / 唤醒 run()）；重复调用无副作用。
   * @returns 无返回值。
   */
  private finish(): void {
    const resolve = this.finishRun;
    this.finishRun = undefined;
    this.state.closed = true;
    this.pending.settleAll({ outcome: 'cancelled' });
    this.registry.shutdown((ids) => this.settlePermissions(ids));
    resolve?.();
  }

  /**
   * 处理一条入站 JSON-RPC 消息（请求 → 分发并回包；通知 → 分发不回包；响应 → 兑现挂起）。
   * @param message 入站消息。
   * @returns 处理完成（异步分发）。
   */
  private async onMessage(message: RpcMessage): Promise<void> {
    if (!('method' in message)) {
      this.onClientResponse(message);
      return;
    }
    const id = 'id' in message ? message.id : undefined;
    const params = (message as { readonly params?: unknown }).params;
    try {
      if (message.method === ACP_METHOD_SESSION_CANCEL) {
        this.cancelSession(params);
        return;
      }
      const result = await this.dispatch(message.method, params);
      if (id !== undefined) this.send(jsonRpc.response(id, result));
    } catch (error) {
      if (id === undefined) return;
      const code = error instanceof AcpRequestError ? error.code : ACP_ERROR_INTERNAL;
      const text = error instanceof Error ? error.message : String(error);
      this.send(jsonRpc.errorResponse(id, code, text));
    }
  }

  /**
   * 按 ACP 方法名分发请求。
   * @param method JSON-RPC 方法名。
   * @param params 方法参数。
   * @returns 方法结果（未知方法抛 `method not found`）。
   */
  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case ACP_METHOD_INITIALIZE:
        return this.initialize(params);
      case ACP_METHOD_AUTHENTICATE:
        return await this.auth.authenticate(params);
      case ACP_METHOD_LOGOUT:
        return this.auth.logout();
      case ACP_METHOD_SESSION_NEW:
        return await this.lifecycle.newSession(params);
      case ACP_METHOD_SESSION_LOAD:
        return await this.lifecycle.loadSession(params);
      case ACP_METHOD_SESSION_LIST:
        return this.lifecycle.listSessions(params);
      case ACP_METHOD_SESSION_RESUME:
        return await this.lifecycle.resumeSession(params);
      case ACP_METHOD_SESSION_CLOSE:
        return this.lifecycle.closeSession(params);
      case ACP_METHOD_SESSION_PROMPT:
        return await this.promptSession(params);
      default:
        throw new AcpRequestError(`未知方法: ${method}`, ACP_ERROR_METHOD_NOT_FOUND);
    }
  }

  /**
   * initialize：协商协议版本并声明能力（会话生命周期 / 认证方式 / prompt / MCP 传输）。
   * @param params 请求参数（protocolVersion 必填）。
   * @returns initialize 响应。
   */
  private initialize(params: unknown): unknown {
    const record = AcpValidation.recordOf(params);
    const version = record['protocolVersion'];
    if (typeof version !== 'number' || !Number.isInteger(version)) {
      throw new AcpRequestError('initialize 缺少整数 protocolVersion', ACP_ERROR_INVALID_PARAMS);
    }
    this.state.clientCapabilities = AcpValidation.recordOf(record['clientCapabilities']);
    const capabilities: AcpAgentCapabilities = {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: { list: {}, resume: {}, close: {} },
      ...(this.auth.hasMethods() ? { auth: { logout: {} } } : {}),
    };
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: capabilities,
      agentInfo: this.deps.agentInfo,
      authMethods: this.auth.methods(),
    };
  }

  /**
   * session/prompt：跑一轮提示，返回 stopReason（取消 / 截断 / 正常结束）。
   * @param params 请求参数（sessionId / prompt 内容块）。
   * @returns `{ stopReason }`。
   */
  private async promptSession(params: unknown): Promise<AcpPromptResponse> {
    this.auth.require();
    const record = AcpValidation.recordOf(params);
    const sessionId = AcpValidation.requireString(record, 'sessionId');
    const state = this.registry.require(sessionId);
    if (state.busy) {
      throw new AcpRequestError(`会话 ${state.id} 已有回合在跑`, ACP_ERROR_INVALID_REQUEST);
    }
    const prompt = AcpValidation.promptTextOf(record['prompt']);
    const firstLine = prompt.split('\n', 1)[0] ?? '';
    this.registry.setTitle(state, firstLine);
    state.cancelRequested = false;
    state.busy = true;
    try {
      const result = await state.runtime.run(prompt);
      return { stopReason: AcpValidation.stopReasonOf(state.cancelRequested, result) };
    } catch (error) {
      if (state.cancelRequested) return { stopReason: 'cancelled' };
      throw new AcpRequestError(
        error instanceof Error ? error.message : String(error),
        ACP_ERROR_INTERNAL,
      );
    } finally {
      state.busy = false;
      this.registry.touch(state);
    }
  }

  /**
   * session/cancel（通知）：标记本轮取消、中止运行时，并把挂起的权限请求按 cancelled 收尾。
   *
   * 对已 close / 未知会话**幂等**（通知没有响应，直接忽略即可）。
   * @param params 请求参数（sessionId）。
   * @returns 无返回值。
   */
  private cancelSession(params: unknown): void {
    const record = AcpValidation.recordOf(params);
    const sessionId = typeof record['sessionId'] === 'string' ? record['sessionId'] : '';
    const state = this.registry.get(sessionId);
    if (state === undefined) return;
    state.cancelRequested = true;
    state.runtime.cancel();
    for (const permissionId of this.registry.permissionIdsOf(sessionId)) {
      this.pending.settle(permissionId, { outcome: 'cancelled' });
      this.registry.removePermissionId(sessionId, permissionId);
    }
  }

  /**
   * 创建会话运行时并登记到活跃表。
   * @param sessionId 会话 id。
   * @param cwd 工作目录。
   * @returns 已登记的会话状态。
   */
  private async openSession(sessionId: string, cwd: string): Promise<AcpSessionState> {
    const identity = this.auth.currentIdentity();
    const runtime = await this.deps.sessionFactory({
      sessionId,
      cwd,
      events: this.eventPortFor(sessionId),
      approvals: this.approvalPortFor(sessionId),
      clientCapabilities: this.state.clientCapabilities,
      ...(identity !== undefined ? { identity } : {}),
    });
    const state: AcpSessionState = {
      id: sessionId,
      cwd,
      runtime,
      mapper: new AcpEventMapper(),
      cancelRequested: false,
      busy: false,
      updatedAt: new Date().toISOString(),
      alwaysDecisions: new Map<string, ApprovalDecision>(),
      ...(identity !== undefined ? { identity } : {}),
    };
    this.registry.add(state);
    return state;
  }

  /**
   * 构造会话事件出口：事件经映射器转为 `session/update` 通知。
   * @param sessionId 会话 id。
   * @returns 事件端口。
   */
  private eventPortFor(sessionId: string): EventPort {
    return {
      name: 'acp',
      emit: (event) => {
        const state = this.registry.get(sessionId);
        if (state === undefined) return;
        for (const update of state.mapper.map(event)) this.sendUpdate(sessionId, update);
      },
    };
  }

  /**
   * 推送一条 session/update 通知（关闭后静默丢弃）。
   * @param sessionId 会话 id。
   * @param update 会话更新。
   * @returns 无返回值。
   */
  private sendUpdate(sessionId: string, update: AcpSessionUpdate): void {
    if (this.state.closed) return;
    this.deps.transport.send(jsonRpc.notify(ACP_METHOD_SESSION_UPDATE, { sessionId, update }));
  }

  /**
   * 构造会话审批端口：读类工具直接放行；写类工具按策略向 Client 请求权限。
   * @param sessionId 会话 id。
   * @returns 审批端口。
   */
  private approvalPortFor(sessionId: string): ApprovalPort {
    return {
      name: 'acp',
      decide: async (request: ApprovalRequest): Promise<ApprovalDecision> => {
        if (this.deps.permissionMode === 'auto') return 'allow';
        if (!ACP_MUTATING.has(request.toolName)) return 'allow';
        return this.requestPermission(sessionId, request);
      },
    };
  }

  /**
   * 向 Client 发 session/request_permission 并等待选择（超时/取消一律按拒绝）。
   *
   * `allow-always` / `reject-always` 会写入**会话级**记忆（按工具名）：本轮之后同一工具
   * 不再弹窗（ACP 语义要求；此前四个选项都只对当次生效，审计 #12）。
   * @param sessionId 会话 id。
   * @param request 审批请求（工具名 + 目标）。
   * @returns allow / deny。
   */
  private async requestPermission(
    sessionId: string,
    request: ApprovalRequest,
  ): Promise<ApprovalDecision> {
    const state = this.registry.get(sessionId);
    const remembered = state?.alwaysDecisions.get(request.toolName);
    if (remembered !== undefined) return remembered;
    const id = this.state.nextRequestId++;
    const permission: AcpPermissionRequest = {
      sessionId,
      toolCall: {
        toolCallId: `perm-${String(id)}`,
        title: `${request.toolName}: ${request.target}`,
        name: request.toolName,
        kind: 'other',
        status: 'pending',
      },
      options: [
        { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
        { optionId: 'allow-always', name: '总是允许', kind: 'allow_always' },
        { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
        { optionId: 'reject-always', name: '总是拒绝', kind: 'reject_always' },
      ],
    };
    this.registry.addPermissionId(sessionId, id);
    const outcome = await new Promise<AcpPermissionOutcome>((resolve) => {
      const timeout =
        this.deps.permissionTimeoutMs > 0
          ? {
              ms: this.deps.permissionTimeoutMs,
              onTimeout: (handlers: { readonly resolve: (v: AcpPermissionOutcome) => void }) =>
                handlers.resolve({ outcome: 'cancelled' }),
            }
          : undefined;
      this.pending.register(id, { resolve }, timeout);
      this.deps.transport.send(
        jsonRpc.request(id, ACP_METHOD_REQUEST_PERMISSION, {
          ...permission,
        } as unknown as Record<string, unknown>),
      );
    });
    this.registry.removePermissionId(sessionId, id);
    const decision = AcpValidation.decisionOf(outcome);
    if (state !== undefined && AcpValidation.isAlwaysOption(outcome)) {
      state.alwaysDecisions.set(request.toolName, decision);
    }
    return decision;
  }

  /**
   * 处理 Client 的响应消息：按 id 兑现挂起的权限请求。
   * @param message 入站响应。
   * @returns 无返回值。
   */
  private onClientResponse(message: RpcMessage): void {
    if (!('id' in message) || typeof message.id !== 'number') return;
    const handlers = this.pending.take(message.id);
    if (handlers === undefined) return;
    if ('error' in message) {
      handlers.resolve({ outcome: 'cancelled' });
      return;
    }
    const response = AcpValidation.recordOf((message as { readonly result?: unknown }).result);
    const outcome = AcpValidation.recordOf(response['outcome']);
    const optionId = outcome['optionId'];
    if (outcome['outcome'] === 'selected' && typeof optionId === 'string') {
      handlers.resolve({ outcome: 'selected', optionId });
      return;
    }
    handlers.resolve({ outcome: 'cancelled' });
  }

  /**
   * 发送一条 JSON-RPC 消息（关闭后静默丢弃）。
   * @param message 待发送消息。
   * @returns 无返回值。
   */
  private send(message: RpcMessage): void {
    if (this.state.closed) return;
    this.deps.transport.send(message);
  }

  /**
   * 把一组挂起权限请求按 cancelled 收尾（close / 传输关闭时调用）。
   * @param permissionIds 权限请求 id 列表。
   * @returns 无返回值。
   */
  private settlePermissions(permissionIds: readonly number[]): void {
    for (const id of permissionIds) this.pending.settle(id, { outcome: 'cancelled' });
  }
}

/** 内容块类型（供测试/调用方构造 prompt 时复用）。 */
export type { AcpContentBlock, AcpPermissionResponse };
