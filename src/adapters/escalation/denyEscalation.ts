import type {
  EscalationDecision,
  EscalationPort,
  EscalationRequest,
} from '../../ports/escalation.js';

/** 永不升级适配器：fail-closed 默认端口，被拒即终止（保持既有安全行为，零依赖）。 */
export class DenyEscalation implements EscalationPort {
  readonly name = 'deny';

  /** 永远 abort，不提权。 */
  async decide(_request: EscalationRequest): Promise<EscalationDecision> {
    return 'abort';
  }
}
