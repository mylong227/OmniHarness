import { jsonRpc } from './jsonRpc.js';
import type { Transport } from '../transport/lineTransport.js';
import type { Metrics } from '../services/metrics.js';
import type { AuditSink } from '../services/auditSink.js';
import { id } from '../../util/id.js';
import type {
  ApprovalDecision,
  ApprovalPort,
  ApprovalRequest,
} from '../../ports/runtime/approval.js';
import type { EventPort } from '../../ports/runtime/eventPort.js';

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
  /** 桥依赖（传输 / 指标 / 审计，指标与审计可缺省）。 */
  private readonly deps: ServerEventBridgeDeps;
  /** 待响应审批挂起表：requestId → 兑现 resolver（respondApproval 兑现后移除）。 */
  private readonly pending = new Map<string, (decision: ApprovalDecision) => void>();

  /**
   * @param deps 传输、指标与审计
   */
  public constructor(deps: ServerEventBridgeDeps) {
    this.deps = deps;
  }

  /**
   * 事件端口：实时推送 thread.event 通知（并记录指标与审计）。
   * @returns 以 server 为名的 EventPort 适配器；emit 即向客户端下发 JSON-RPC 通知
   */
  public eventPort(): EventPort {
    return {
      name: 'server',
      emit: (event) => {
        this.deps.metrics?.recordEvent(event);
        this.deps.audit?.record({ type: event.type, sessionId: event.sessionId, detail: event });
        this.deps.transport.send(
          jsonRpc.notify('thread.event', { threadId: event.sessionId, event }),
        );
      },
    };
  }

  /**
   * 审批端口：上行至客户端。
   * @returns 以 server 为名的 ApprovalPort 适配器；decide 即发起审批上行并等待决策
   */
  public approvalPort(): ApprovalPort {
    return {
      name: 'server',
      decide: (request) => this.requestApproval(request),
    };
  }

  /**
   * 审批上行：发请求通知并等待响应。
   * @param request 审批请求（工具名与目标，随 `approval.request` 通知下发）
   * @returns 客户端决策（allow/deny）；决策由 `approval.respond` 按 requestId 兑现挂起 resolver
   */
  public async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const requestId = id('apr');
      this.pending.set(requestId, resolve);
      this.deps.transport.send(
        jsonRpc.notify('approval.request', {
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
