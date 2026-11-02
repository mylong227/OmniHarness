/** 审批请求。 */
export interface ApprovalRequest {
  readonly sessionId: string;
  readonly toolName: string;
  readonly target: string;
  /**
   * 工具入参（可选，2026-11-01）：随审批上行下发，让审批弹窗能看到「到底要执行什么」——
   * 此前只有 toolName + target，用户在盲审（前端 ApprovalModal 的 args 渲染分支一直是死的）。
   * 载荷体积由服务端桥截断（serverEventBridge 的 argsPayloadOf，8KiB 上限）。
   */
  readonly args?: Record<string, unknown> | undefined;
}
