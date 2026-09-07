// 可重放模型适配器（eval harness 专用）：按脚本顺序 replay 模型输出，确定性、零 API Key。
//
// 设计：脚本每步要么产出工具调用（toolCalls），要么产出文本（text）。Agent 主循环拿到
// toolCalls 会执行并再次请求模型 → 取下一步；当某步无 toolCalls 或脚本耗尽时返回 finalText，
// 主循环据此结束。这样一条 eval 任务就是一段「模型脚本 + 期望断言」，无需真实 LLM 即可
// 回归验证工具链路、审批/沙箱门禁、事件记录等真实运行时行为。

import type { ModelOutput, ModelPort, ModelRequest } from '../ports/model.js';
import type { ToolCall } from '../ports/tool.js';

/**
 * @beta
 * 脚本单步：产出工具调用或文本（二者至少其一）。
 */
export interface ScriptStep {
  /** 助手文本（终态或说明性输出）。 */
  readonly text?: string;
  /** 本步要执行的工具调用；非空则主循环会执行并进入下一步。 */
  readonly toolCalls?: readonly ToolCall[];
}

/**
 * @beta
 * 脚本化模型：严格 replay 给定脚本，绝不随机。
 */
export class ScriptedModel implements ModelPort {
  readonly name = 'scripted';

  private turn = 0;

  /** @param script 模型响应序列 @param finalText 脚本耗尽后的兜底终态文本 */
  constructor(
    private readonly script: readonly ScriptStep[],
    private readonly finalText = '任务完成（eval）',
  ) {}

  /** 生成响应：顺序取脚本步，耗尽则返回 finalText。 */
  async generate(_req: ModelRequest): Promise<ModelOutput> {
    const step = this.script[this.turn] ?? { text: this.finalText };
    this.turn += 1;
    if (step.toolCalls !== undefined && step.toolCalls.length > 0) {
      return { toolCalls: step.toolCalls };
    }
    return { text: step.text ?? this.finalText };
  }
}
