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
}
