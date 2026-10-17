/**
 * 升级审批端口契约聚合（桶）。
 *
 * 本文件已退化为桶：4 个接口各自独立成文件于 `./escalation/`，调用点零改动。
 */

export type { EscalationDecision } from './escalation/escalationDecision.ts';
export type { EscalationDeniedBy } from './escalation/escalationDeniedBy.ts';
export type { EscalationRequest } from './escalation/escalationRequest.ts';
export type { EscalationPort } from './escalation/escalationPort.ts';
