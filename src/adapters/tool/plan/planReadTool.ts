import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { PlanPort } from '../../../ports/runtime/plan.js';

/**
 * @beta
 * `plan_read`：读取当前计划态快照。
 */
export class PlanReadTool {
  /**
   * 工具定义：plan_read 工具的名称、描述与参数 schema。
   * 读取当前计划草稿与审批状态快照。
   */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.planRead,
    description: '读取当前计划草稿与审批状态。',
    parameters: { type: 'object', properties: {} },
  };

  public constructor(private readonly plan: PlanPort) {}

  /**
   * 执行 plan_read：返回当前计划态快照。
   * @param call 模型传入的工具调用（本工具无参数）。
   * @param _ctx 工具执行上下文（本工具不依赖，保留签名兼容）。
   * @returns 尚未起草返回提示文本；否则返回计划 JSON（始终 ok:true）。
   */
  public async handle(call: ToolCall, _ctx: ToolContext): Promise<ToolResult> {
    const state = this.plan.get();
    if (state === null) {
      return { callId: call.id, ok: true, output: '(尚无计划)' };
    }
    return { callId: call.id, ok: true, output: JSON.stringify(state) };
  }
}
