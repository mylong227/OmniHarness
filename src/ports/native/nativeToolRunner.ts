import type { ToolCall, ToolResult } from '../tool/tool.ts';

/**
 * @beta
 * 原生工具执行器最小面（便于测试注入 stub，解耦具体 NativeKernel）。
 *
 * 已从 `native/nativeBackend.ts` 外迁到 ports/native：原文件退化为纯再导出桶，调用点零改动。
 */
export interface NativeToolRunner {
  /**
   * 本后端是否声明对该 JS 工具名具备**语义等价**的执行能力。
   *
   * 可选：stub 实现可缺省（调用方按「支持」处理，保持既有测试/嵌入方行为）。
   * 真实后端应显式实现——语义不等价却接管，会把参数/输出悄悄改成另一套契约。
   */
  supports?(toolName: string): boolean;
  /** 经 Rust 内核执行工具。内部失败（非业务拒绝）应抛错以触发 JS 回退。 */
  runTool(call: ToolCall): ToolResult;
  /** 经 Rust 内核批量估算消息 token 数（单次 FFI 往返）。可选，缺省回退 JS。 */
  estimateTokens?(messages: readonly { content: string }[]): number;
  /**
   * 执行前把内核 fs 沙箱根对齐到期望的工作区根（2026-10-13「内核根跑偏」守门）。
   * 可选：stub 实现可不提供（调用点以 `?.` 调用）。内核无 root.* 方法（旧 .node）时实现方
   * 应**静默降级**（记一次告警后不再重试），保持原生加速可用——与旧版行为逐字节一致。
   */
  syncWorkspaceRoot?(expected: string): void;
}
