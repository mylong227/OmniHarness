import type { CheckpointManager } from '../../core/checkpointManager.js';
import type { RegistryToolPort } from './registryToolPort.js';
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import { rollbackDefinition, makeRollbackHandler } from './rollbackTool.js';

/** `checkpoint` 工具定义：为当前会话打快照。 */
export const checkpointDefinition: ToolDefinition = {
  name: 'checkpoint',
  description:
    '为当前会话打快照，保存事件日志到指定 label；之后可用 rollback 回滚（Escape 式安全网）。',
  parameters: {
    type: 'object',
    properties: {
      label: { type: 'string', description: '快照标签，如 "before-refactor"' },
    },
    required: ['label'],
  },
};

/** 构造 checkpoint 处理函数（闭包持有 manager）。 */
export function makeCheckpointHandler(manager: CheckpointManager) {
  return async function checkpointHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const label =
      typeof call.arguments['label'] === 'string' ? (call.arguments['label'] as string) : '';
    if (label.length === 0) {
      return { callId: call.id, ok: false, error: 'label 不能为空' };
    }
    const meta = await manager.snapshot(ctx.sessionId, label);
    return {
      callId: call.id,
      ok: true,
      output: `已创建检查点 ${meta.label}（${meta.eventCount} 事件，ts ${meta.ts}）`,
    };
  };
}

/**
 * 注册 checkpoint + rollback 两个工具到 registry（中央接线时调用，不在此处 import 配置）。
 * 注意：manager 由调用方创建并传入，本函数保持零配置依赖。
 */
export function registerCheckpointTools(
  registry: RegistryToolPort,
  manager: CheckpointManager,
): void {
  registry.register(checkpointDefinition, makeCheckpointHandler(manager));
  registry.register(rollbackDefinition, makeRollbackHandler(manager));
}
