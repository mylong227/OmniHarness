import type {
  EscalationDecision,
  EscalationPort,
  EscalationRequest,
} from '../../ports/runtime/escalation.js';

/** 永不升级适配器：fail-closed 默认端口，被拒即终止（保持既有安全行为，零依赖）。 */
export class DenyEscalation implements EscalationPort {
  /**
   * 升级器标识：固定为 'deny'，用于区分永不升级、被拒即终止的 fail-closed 实现。
   */
  public readonly name = 'deny';

  /** 永远 abort，不提权。
   * @param _request 升级请求（本实现不读取内容，保留参数以符合端口签名）。
   * @returns 恒为 'abort'（fail-closed）。
   */
  public async decide(_request: EscalationRequest): Promise<EscalationDecision> {
    return 'abort';
  }
}
