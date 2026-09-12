import type {
  EscalationDecision,
  EscalationPort,
  EscalationRequest,
} from '../../ports/escalation.js';

/** 询问式升级审批选项。 */
export interface AskEscalationOptions {
  /** 交互裁决器：交人工/TTY/LLM 判断 escalate 还是 abort（对标 Codex request_permissions 的交互提权）。 */
  readonly askHandler: (request: EscalationRequest) => Promise<EscalationDecision>;
}

/** 询问式升级审批适配器：提权与否完全由 askHandler 决定（不预设策略）。 */
export class AskEscalation implements EscalationPort {
  /**
   * 升级器标识：固定为 'ask'，用于在多升级后端中区分交互式提权实现。
   */
  public readonly name = 'ask';

  private readonly askHandler: (request: EscalationRequest) => Promise<EscalationDecision>;

  public constructor(private readonly options: AskEscalationOptions) {
    this.askHandler = options.askHandler;
  }

  /** 委派给 askHandler 裁决。 */
  public async decide(request: EscalationRequest): Promise<EscalationDecision> {
    return this.askHandler(request);
  }
}
