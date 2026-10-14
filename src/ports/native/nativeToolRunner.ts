import type { ToolCall, ToolResult } from '../tool/tool.js';

/**
 * @beta
 * 原生工具执行器最小面（便于测试注入 stub，解耦具体 NativeKernel）。
 *
 * 已从 `native/nativeBackend.ts` 外迁到 ports/native：原文件退化为纯再导出桶，调用点零改动。
 */
export interface NativeToolRunner {
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
