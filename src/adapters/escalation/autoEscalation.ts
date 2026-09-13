import type {
  EscalationDecision,
  EscalationPort,
  EscalationRequest,
} from '../../ports/runtime/escalation.js';

/** 自动升级审批选项。 */
export interface AutoEscalationOptions {
  /** 永不自动提权的危险动作前缀（命中即 abort，fail-closed 友好）。 */
  readonly blockPrefixes?: readonly string[];
}

/** 自动升级适配器：非危险动作被沙箱拒绝即自动提权重试（省交互）；危险动作仍 abort 不绕过。 */
export class AutoEscalation implements EscalationPort {
  /**
   * 升级器标识：固定为 'auto'，用于区分被沙箱拒绝后自动提权重试的实现。
   */
  public readonly name = 'auto';

  /** 危险动作前缀表（缺省 rm/del/sudo/mkfs/dd；命中即 abort，不提权）。 */
  private readonly blockPrefixes: readonly string[];

  public constructor(
    /** 升级选项（可覆盖默认危险前缀表）。 */
    private readonly options: AutoEscalationOptions = {},
  ) {
    this.blockPrefixes = options.blockPrefixes ?? ['rm ', 'del ', 'sudo', 'mkfs', 'dd '];
  }

  /** 危险前缀命中即 abort；否则 escalate（提权重试）。
   * @param request 升级请求（target 为被沙箱拒绝的动作目标字符串）。
   * @returns 'abort'（危险动作）或 'escalate'（普通动作自动提权）。
   */
  public async decide(request: EscalationRequest): Promise<EscalationDecision> {
    if (this.blockPrefixes.some((prefix) => request.target.startsWith(prefix))) {
      return 'abort';
    }
    return 'escalate';
  }
}
