import type { CheckpointManagerPort } from '../../../ports/runtime/checkpointManager.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { ToolHandler } from '../toolHandler.js';

/** `rollback` 工具定义：回滚当前会话到指定/最近检查点。 */
export const rollbackDefinition: ToolDefinition = {
  name: 'rollback',
  description:
    '把当前会话回滚到检查点（覆盖当前事件日志，实现"回到该点"）。' +
    '不指定 label 时回滚到最近一次快照；无检查点时失败（fail-closed）。',
  parameters: {
    type: 'object',
    properties: {
      label: { type: 'string', description: '可选：快照标签；缺省回滚到最近一次检查点' },
    },
  },
};

/**
 * 构造 `rollback` 工具的处理函数（闭包持有 `manager`）。
 * @param manager 检查点管理器（调用方创建并传入，保持零配置依赖）
 * @returns 符合 `ToolHandler` 的处理函数：回滚到指定/最近检查点并返回结果
 */
export function makeRollbackHandler(manager: CheckpointManagerPort): ToolHandler {
  return async function rollbackHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const raw = call.arguments['label'];
    const label = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    try {
      const meta = await manager.rollback(ctx.sessionId, label);
      return {
        callId: call.id,
        ok: true,
        output: `已回滚到检查点 ${meta.label}（${meta.eventCount} 事件）`,
      };
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
