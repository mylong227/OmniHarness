import { JsonRpc } from './jsonRpc.js';
import type { Transport } from './lineTransport.js';
import type { Metrics } from './metrics.js';
import type { AuditSink } from './audit.js';
import { id } from '../util/id.js';
import type { ApprovalDecision, ApprovalPort, ApprovalRequest } from '../ports/approval.js';
import type { EventPort } from '../ports/eventPort.js';

/** 事件/审批桥依赖。 */
export interface ServerEventBridgeDeps {
  /** JSON-RPC 传输（通知下行 / 审批上行）。 */
  readonly transport: Transport;
  /** 指标（thread.event 计数）。 */
  readonly metrics?: Metrics;
  /** 审计 sink（事件落盘）。 */
  readonly audit?: AuditSink;
}

/**
 * 服务端与客户端的双向通道桥：实时事件下行（`thread.event`）与审批请求上行
 * （`approval.request` → `approval.respond`）。
 *
 * 持有「待响应审批」挂起表——`requestApproval` 注册 resolver，`respondApproval`
 * 按 requestId 兑现；两者同处本类，避免 resolver 表散落在 server 各处。
 */
export class ServerEventBridge {
  private readonly deps: ServerEventBridgeDeps;
  private readonly pending = new Map<string, (decision: ApprovalDecision) => void>();

  /**
   * @param deps 传输、指标与审计
   */
  public constructor(deps: ServerEventBridgeDeps) {
    this.deps = deps;
  }

  /** 事件端口：实时推送 thread.event 通知（并记录指标与审计）。 */
  public eventPort(): EventPort {
    return {
      name: 'server',
      emit: (event) => {
        this.deps.metrics?.recordEvent(event);
        this.deps.audit?.record({ type: event.type, sessionId: event.sessionId, detail: event });
        this.deps.transport.send(
          JsonRpc.notify('thread.event', { threadId: event.sessionId, event }),
        );
      },
    };
  }

  /** 审批端口：上行至客户端。 */
  public approvalPort(): ApprovalPort {
    return {
      name: 'server',
      decide: (request) => this.requestApproval(request),
    };
  }

  /** 审批上行：发请求通知并等待响应。 */
  public async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const requestId = id('apr');
      this.pending.set(requestId, resolve);
      this.deps.transport.send(
        JsonRpc.notify('approval.request', {
          requestId,
          toolName: request.toolName,
          target: request.target,
        }),
      );
    });
  }

  /**
   * 响应审批上行：按 requestId 兑现挂起的 resolver（未知 id 静默）。
   * @param params `{ requestId: string; decision?: unknown }`
   * @returns `{ ok: true }`
   */
  public respondApproval(params: Record<string, unknown>): unknown {
    const requestId = String(params['requestId'] ?? '');
    const resolve = this.pending.get(requestId);
    if (resolve !== undefined) {
      resolve(params['decision'] === 'allow' ? 'allow' : 'deny');
      this.pending.delete(requestId);
    }
    return { ok: true };
  }
}
