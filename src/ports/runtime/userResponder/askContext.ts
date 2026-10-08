/**
 * @beta
 * 提问上下文：`questions` 之外的「谁在问」。
 *
 * 存在理由（2026-10-08）：回答端口原先只有 `ask(questions)` 一个入参，而上行通道
 * （`question.request` 通知）必须让客户端知道**该问题属于哪个会话**——否则多会话并存时
 * UI 只能把问题当成「全局弹窗」，本仓已多次出现过「串会话」缺陷。上下文**可选**：
 * 不带它的调用方（旧实现、测试桩）语义不变。
 */
export interface AskContext {
  /** 提问所属会话 id（上行通道据此把问题归到正确会话）。 */
  readonly sessionId?: string;
}
