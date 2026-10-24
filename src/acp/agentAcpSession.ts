import type { Agent } from '../core/agent.ts';
import type { SessionEvent } from '../ports/runtime/event.ts';
import type { EventPort } from '../ports/runtime/eventPort.ts';
import type { ApprovalPort } from '../ports/runtime/approval.ts';

/** 一轮 prompt 的产出（供 ACP 服务端映射 stopReason）。 */
export interface AcpRunResult {
  /** 最终答复文本（模型未产出正文时为 undefined）。 */
  readonly finalText?: string | undefined;
  /** 实际执行步数。 */
  readonly steps: number;
  /** 是否被取消（取消令牌导致回合中止）。 */
  readonly aborted: boolean;
  /** 是否因步数/token 上限被截断。 */
  readonly truncated: boolean;
}

/** 会话运行时的最小契约（服务端只依赖它，测试可注入替身）。 */
export interface AcpSessionRuntime {
  /**
   * 跑一轮用户提示。
   * @param prompt 用户文本（内容块中的文本已由服务端拼接）。
   * @returns 本轮结果。
   */
  run(prompt: string): Promise<AcpRunResult>;
  /**
   * 读取会话历史（session/load 回放用）。
   * @returns 会话事件（按时间顺序）。
   */
  load(): Promise<readonly SessionEvent[]>;
  /** 取消正在进行的回合（session/cancel）。 */
  cancel(): void;
}

/** 创建会话运行时所需的外部依赖。 */
export interface AcpSessionOptions {
  /** ACP 会话 id（同时作为 Agent 会话 id，保持事件流归属一致）。 */
  readonly sessionId: string;
  /** 工作目录（Client 传入的绝对路径）。 */
  readonly cwd: string;
  /** 事件出口（服务端据此发 session/update）。 */
  readonly events: EventPort;
  /** 审批端口（服务端据此发 session/request_permission）。 */
  readonly approvals: ApprovalPort;
  /** Client 声明的能力（透传，供实现方按需降级）。 */
  readonly clientCapabilities?: Readonly<Record<string, unknown>>;
}

/** 会话运行时工厂（CLI 装配真实 Agent，测试注入替身）。 */
export type AcpSessionFactory = (options: AcpSessionOptions) => Promise<AcpSessionRuntime>;

/**
 * 基于现有 Agent 运行时的 ACP 会话：首轮 `runTask(sessionId)`，后续 `resume(sessionId)`。
 *
 * 会话 id 直接复用 ACP 的 sessionId（不另造映射表）——这样事件流、存储归档、
 * 取消令牌三处天然指向同一个会话，避免「ACP 会话 A 取消到了 Agent 会话 B」。
 */
export class AgentAcpSession implements AcpSessionRuntime {
  /** 本会话是否已产生过回合（决定 runTask 还是 resume）。 */
  private started = false;

  /**
   * @param agent 已装配的 Agent 运行时。
   * @param sessionId ACP 会话 id（同时作为 Agent 会话 id）。
   */
  public constructor(
    private readonly agent: Agent,
    public readonly sessionId: string,
  ) {}

  /**
   * 跑一轮提示：首轮新建会话，之后续跑同一会话。
   * @param prompt 用户文本。
   * @returns 本轮结果（含 aborted / truncated，供 stopReason 判定）。
   */
  public async run(prompt: string): Promise<AcpRunResult> {
    const result = this.started
      ? await this.agent.resume(this.sessionId, prompt)
      : await this.agent.runTask(prompt, undefined, undefined, this.sessionId);
    this.started = true;
    return {
      ...(result.finalText !== undefined ? { finalText: result.finalText } : {}),
      steps: result.steps,
      aborted: result.aborted === true,
      truncated: result.truncated === true,
    };
  }

  /**
   * 读取历史事件（纯读，不广播），供 session/load 回放。
   * @returns 会话事件列表（不存在时为空数组）。
   */
  public async load(): Promise<readonly SessionEvent[]> {
    const events = await this.agent.eventsOf(this.sessionId);
    // 加载过的会话下一次 prompt 必须走 resume：否则 runTask 会把历史整段覆盖掉。
    this.started = true;
    return events;
  }

  /** 取消在跑回合（Agent 的取消令牌按 sessionId 隔离）。     * @returns 无返回值。
   */
  public cancel(): void {
    this.agent.cancelCurrentRun('user', this.sessionId);
  }
}
