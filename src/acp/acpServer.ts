import type { RpcMessage } from '../server/core/jsonRpc.ts';
import { jsonRpc } from '../server/core/jsonRpc.ts';
import { Id } from '../util/id.ts';
import { API_VERSION } from '../version.ts';
import { PendingRequests } from '../util/concurrency/pendingRequests.ts';
import type { EventPort } from '../ports/runtime/eventPort.ts';
import type { ApprovalPort, ApprovalDecision } from '../ports/runtime/approval.ts';
import type { ApprovalRequest } from '../ports/runtime/approval.ts';
import { MUTATING_TOOL_NAMES } from '../ports/tool/toolNames.ts';
import { AcpEventMapper } from './acpEventMapper.ts';
import { AcpRequestError } from './acpRequestError.ts';
import { AcpValidation } from './acpValidation.ts';
import type { AcpSessionFactory, AcpSessionRuntime } from './agentAcpSession.ts';
import type { AcpTransport } from './acpStdioTransport.ts';
import type {
  AcpContentBlock,
  AcpImplementation,
  AcpPermissionMode,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPromptResponse,
} from './acpProtocol.ts';
import {
  ACP_ERROR_INTERNAL,
  ACP_ERROR_INVALID_PARAMS,
  ACP_ERROR_INVALID_REQUEST,
  ACP_ERROR_METHOD_NOT_FOUND,
  ACP_METHOD_INITIALIZE,
  ACP_METHOD_REQUEST_PERMISSION,
  ACP_METHOD_SESSION_CANCEL,
  ACP_METHOD_SESSION_LOAD,
  ACP_METHOD_SESSION_NEW,
  ACP_METHOD_SESSION_PROMPT,
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
}

/** 一条活跃会话的运行时状态。 */
interface AcpSessionState {
  /** 会话 id。 */
  readonly id: string;
  /** 工作目录。 */
  readonly cwd: string;
  /** 运行时（真实 Agent 或测试替身）。 */
  readonly runtime: AcpSessionRuntime;
  /** 事件 → ACP 更新映射器。 */
  readonly mapper: AcpEventMapper;
  /** 本轮是否收到过 session/cancel。 */
  cancelRequested: boolean;
  /** 是否有 prompt 回合在跑。 */
  busy: boolean;
}

/**
 * ACP v1 Agent 服务端（JSON-RPC over stdio）。
 *
 * 覆盖：initialize（版本/能力）、session/new|load|prompt、session/cancel、
 * session/update（文本/思考/工具调用/计划）、session/request_permission（权限请求/响应）。
 * 运行时映射见 `AgentAcpSession`：会话 id 直接复用 Agent 会话 id。
 */
export class AcpServer {
  /** 传输端口。 */
  private readonly transport: AcpTransport;
  /** 会话工厂。 */
  private readonly sessionFactory: AcpSessionFactory;
  /** 权限策略。 */
  private readonly permissionMode: AcpPermissionMode;
  /** 权限等待上限（毫秒；0 = 不限时）。 */
  private readonly permissionTimeoutMs: number;
  /** Agent 实现信息。 */
  private readonly agentInfo: AcpImplementation;
  /** 活跃会话表。 */
  private readonly sessions = new Map<string, AcpSessionState>();
  /** 在途的 Client 请求（权限请求 id → 结果）。 */
  private readonly pending = new PendingRequests<number, AcpPermissionOutcome>();
  /** 会话 → 该会话挂起的权限请求 id（取消时逐一收尾）。 */
  private readonly permissionIds = new Map<string, Set<number>>();
  /** 会话级可变状态（能力/请求 id/关闭位合并，避免字段数膨胀）。 */
  private readonly state = {
    clientCapabilities: {} as Record<string, unknown>,
    nextRequestId: 1,
    closed: false,
  };

  /**
   * @param options 传输、会话工厂与权限策略。
   */
  public constructor(options: AcpServerOptions) {
    this.transport = options.transport;
    this.sessionFactory = options.sessionFactory;
    this.permissionMode = options.permissionMode ?? 'client';
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.agentInfo = options.agentInfo ?? {
      name: 'omniharness',
      title: 'OmniHarness',
      version: API_VERSION,
    };
  }

  /**
   * 启动服务并等待传输关闭（stdio EOF / 进程断开）。
   * @returns 传输关闭时 resolve。
   */
  public async run(): Promise<void> {
    this.transport.onMessage((message) => void this.onMessage(message));
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        this.state.closed = true;
        this.pending.settleAll({ outcome: 'cancelled' });
        for (const ids of this.permissionIds.values()) ids.clear();
        this.permissionIds.clear();
        resolve();
      };
      if (this.transport.onClose === undefined) return;
      this.transport.onClose(finish);
    });
  }

  /**
   * 关闭服务（主动断开传输并收尾挂起请求）。
   * @returns 无返回值。
   */
  public close(): void {
    this.state.closed = true;
    this.pending.settleAll({ outcome: 'cancelled' });
    this.transport.close?.();
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
      case ACP_METHOD_SESSION_NEW:
        return await this.newSession(params);
      case ACP_METHOD_SESSION_LOAD:
        return await this.loadSession(params);
      case ACP_METHOD_SESSION_PROMPT:
        return await this.promptSession(params);
      default:
        throw new AcpRequestError(`未知方法: ${method}`, ACP_ERROR_METHOD_NOT_FOUND);
    }
  }

  /**
   * initialize：协商协议版本并声明能力（loadSession / promptCapabilities / MCP 传输）。
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
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: {},
      },
      agentInfo: this.agentInfo,
      authMethods: [],
    };
  }

  /**
   * session/new：按 Client 给出的 cwd 创建独立会话。
   * @param params 请求参数（cwd 必须是绝对路径）。
   * @returns `{ sessionId }`。
   */
  private async newSession(params: unknown): Promise<unknown> {
    const record = AcpValidation.recordOf(params);
    const cwd = AcpValidation.requireAbsoluteCwd(record);
    const sessionId = Id.id('sess');
    const state = await this.openSession(sessionId, cwd);
    return { sessionId: state.id };
  }

  /**
   * session/load：创建（或复用）会话运行时并回放历史事件。
   * @param params 请求参数（sessionId / cwd）。
   * @returns 空对象。
   */
  private async loadSession(params: unknown): Promise<unknown> {
    const record = AcpValidation.recordOf(params);
    const sessionId = AcpValidation.requireString(record, 'sessionId');
    const cwd = AcpValidation.requireAbsoluteCwd(record);
    const existing = this.sessions.get(sessionId);
    const state = existing ?? (await this.openSession(sessionId, cwd));
    const events = await state.runtime.load();
    for (const event of events) {
      for (const update of state.mapper.map(event, { replay: true })) {
        if (!this.state.closed)
          this.transport.send(
            jsonRpc.notify(ACP_METHOD_SESSION_UPDATE, { sessionId: state.id, update }),
          );
      }
    }
    return {};
  }

  /**
   * session/prompt：跑一轮提示，返回 stopReason（取消 / 截断 / 正常结束）。
   * @param params 请求参数（sessionId / prompt 内容块）。
   * @returns `{ stopReason }`。
   */
  private async promptSession(params: unknown): Promise<AcpPromptResponse> {
    const record = AcpValidation.recordOf(params);
    const state = this.requireSession(record);
    if (state.busy) {
      throw new AcpRequestError(`会话 ${state.id} 已有回合在跑`, ACP_ERROR_INVALID_REQUEST);
    }
    const prompt = AcpValidation.promptTextOf(record['prompt']);
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
    }
  }

  /**
   * session/cancel（通知）：标记本轮取消、中止运行时，并把挂起的权限请求按 cancelled 收尾。
   * @param params 请求参数（sessionId）。
   * @returns 无返回值。
   */
  private cancelSession(params: unknown): void {
    const record = AcpValidation.recordOf(params);
    const sessionId = typeof record['sessionId'] === 'string' ? record['sessionId'] : '';
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    state.cancelRequested = true;
    state.runtime.cancel();
    for (const id of this.permissionIds.get(sessionId) ?? []) {
      this.pending.settle(id, { outcome: 'cancelled' });
    }
    this.permissionIds.delete(sessionId);
  }

  /**
   * 创建会话运行时并登记到活跃表。
   * @param sessionId 会话 id。
   * @param cwd 工作目录。
   * @returns 已登记的会话状态。
   */
  private async openSession(sessionId: string, cwd: string): Promise<AcpSessionState> {
    const runtime = await this.sessionFactory({
      sessionId,
      cwd,
      events: this.eventPortFor(sessionId),
      approvals: this.approvalPortFor(sessionId),
      clientCapabilities: this.state.clientCapabilities,
    });
    const state: AcpSessionState = {
      id: sessionId,
      cwd,
      runtime,
      mapper: new AcpEventMapper(),
      cancelRequested: false,
      busy: false,
    };
    this.sessions.set(sessionId, state);
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
        const state = this.sessions.get(sessionId);
        if (state !== undefined) {
          for (const update of state.mapper.map(event)) {
            if (!this.state.closed)
              this.transport.send(
                jsonRpc.notify(ACP_METHOD_SESSION_UPDATE, { sessionId: state.id, update }),
              );
          }
        }
      },
    };
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
        if (this.permissionMode === 'auto') return 'allow';
        if (!ACP_MUTATING.has(request.toolName)) return 'allow';
        return this.requestPermission(sessionId, request);
      },
    };
  }

  /**
   * 向 Client 发 session/request_permission 并等待选择（超时/取消一律按拒绝）。
   * @param sessionId 会话 id。
   * @param request 审批请求（工具名 + 目标）。
   * @returns allow / deny。
   */
  private async requestPermission(
    sessionId: string,
    request: ApprovalRequest,
  ): Promise<ApprovalDecision> {
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
    const ids = this.permissionIds.get(sessionId) ?? new Set<number>();
    ids.add(id);
    this.permissionIds.set(sessionId, ids);
    const outcome = await new Promise<AcpPermissionOutcome>((resolve) => {
      const timeout =
        this.permissionTimeoutMs > 0
          ? {
              ms: this.permissionTimeoutMs,
              onTimeout: (handlers: { readonly resolve: (v: AcpPermissionOutcome) => void }) =>
                handlers.resolve({ outcome: 'cancelled' }),
            }
          : undefined;
      this.pending.register(id, { resolve }, timeout);
      this.transport.send(
        jsonRpc.request(id, ACP_METHOD_REQUEST_PERMISSION, {
          ...permission,
        } as unknown as Record<string, unknown>),
      );
    });
    ids.delete(id);
    if (ids.size === 0) this.permissionIds.delete(sessionId);
    return AcpValidation.decisionOf(outcome);
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
    this.transport.send(message);
  }

  /**
   * 取会话；不存在即非法参数。
   * @param record 请求参数对象。
   * @returns 会话状态。
   */
  private requireSession(record: Record<string, unknown>): AcpSessionState {
    const sessionId = AcpValidation.requireString(record, 'sessionId');
    const state = this.sessions.get(sessionId);
    if (state === undefined) {
      throw new AcpRequestError(`未知会话: ${sessionId}`, ACP_ERROR_INVALID_PARAMS);
    }
    return state;
  }
}

/** 内容块类型（供测试/调用方构造 prompt 时复用）。 */
export type { AcpContentBlock, AcpPermissionResponse };
