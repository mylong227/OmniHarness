/** 拒绝来源（当前仅 sandbox 触发升级；审批策略拒绝不升级，避免绕过既定策略）。 */
export type EscalationDeniedBy = 'sandbox' | 'approval';
