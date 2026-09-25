import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
import type { CheckpointManagerPort } from '../../../ports/runtime/checkpointManager.js';
import type { RegistryToolPort } from '../registryToolPort.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { ToolHandler } from '../toolHandler.js';
import { rollbackDefinition, RollbackTool } from './rollbackTool.js';

/**
 * CheckpointTool —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class CheckpointTool {
  /**
   * 构造 `checkpoint` 工具的处理函数（闭包持有 `manager`）。
   *
   * 标签**在白名单内**才落盘（2026-09-22 修，审计 P2）：label 是模型可控参数，而它会被拼进
   * 快照文件路径（`<stateDir>/<sessionId>/<label>.files.json`）⇒ 不校验即可路径穿越。
   * 管理器侧亦有同样的白名单与包含性断言（纵深防御，覆盖非工具调用方）。
   * @param manager 检查点管理器（调用方创建并传入，保持零配置依赖）
   * @returns 符合 `ToolHandler` 的处理函数：为当前会话打快照并返回结果
   */
  public static makeCheckpointHandler(manager: CheckpointManagerPort): ToolHandler {
    return async function checkpointHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
      const label =
        typeof call.arguments['label'] === 'string' ? (call.arguments['label'] as string) : '';
      if (label.length === 0) {
        return { callId: call.id, ok: false, error: 'label 不能为空' };
      }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(label)) {
        return {
          callId: call.id,
          ok: false,
          error: `label 非法（仅允许字母数字与 _ -，长度 1–64）：${label.slice(0, 80)}`,
        };
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
  public static registerCheckpointTools(
    registry: RegistryToolPort,
    manager: CheckpointManagerPort,
  ): void {
    registry.register(checkpointDefinition, CheckpointTool.makeCheckpointHandler(manager));
    registry.register(rollbackDefinition, RollbackTool.makeRollbackHandler(manager));
  }
}

/** `checkpoint` 工具定义：为当前会话打快照。 */
export const checkpointDefinition: ToolDefinition = {
  name: TOOL_NAMES.checkpoint,
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
