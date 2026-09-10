import type {
  EscalationDecision,
  EscalationPort,
  EscalationRequest,
} from '../../ports/escalation.js';

/** 自动升级审批选项。 */
export interface AutoEscalationOptions {
  /** 永不自动提权的危险动作前缀（命中即 abort，fail-closed 友好）。 */
  readonly blockPrefixes?: readonly string[];
}

/** 自动升级适配器：非危险动作被沙箱拒绝即自动提权重试（省交互）；危险动作仍 abort 不绕过。 */
export class AutoEscalation implements EscalationPort {
  public readonly name = 'auto';

  private readonly blockPrefixes: readonly string[];

  public constructor(private readonly options: AutoEscalationOptions = {}) {
    this.blockPrefixes = options.blockPrefixes ?? ['rm ', 'del ', 'sudo', 'mkfs', 'dd '];
  }

  /** 危险前缀命中即 abort；否则 escalate（提权重试）。 */
  public async decide(request: EscalationRequest): Promise<EscalationDecision> {
    if (this.blockPrefixes.some((prefix) => request.target.startsWith(prefix))) {
      return 'abort';
    }
    return 'escalate';
  }
}
