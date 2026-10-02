// 确定性可重放模型适配器（核心单测专用）：按脚本顺序 replay 模型输出，确定性、零 API Key。
//
// 设计：脚本每步要么产出工具调用（toolCalls），要么产出文本（text）。Agent 主循环拿到
// toolCalls 会执行并再次请求模型 → 取下一步；当某步无 toolCalls 或脚本耗尽时返回 finalText，
// 主循环据此结束。这样一段「模型脚本 + 期望断言」，无需真实 LLM 即可
// 回归验证工具链路、审批/沙箱门禁、事件记录等真实运行时行为。

import type { ModelOutput, ModelPort, ModelRequest } from '../ports/model/model.js';
import type { ToolCall } from '../ports/tool/tool.js';

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
  /** 模型端口标识：固定为 'scripted'。 */
  public readonly name = 'scripted';

  /** 当前 replay 步序（从 0 开始，每次 generate 自增）。 */
  private turn = 0;

  /** @param script 模型响应序列 @param finalText 脚本耗尽后的兜底终态文本 */
  public constructor(
    private readonly script: readonly ScriptStep[],
    private readonly finalText = '任务完成',
  ) {}

  /**
   * 生成响应：顺序取脚本步，耗尽则返回 finalText。
   * @param _req 模型请求（本适配器确定性 replay 脚本，不消费请求内容）
   * @returns 模型输出（工具调用或终态文本）
   */
  public async generate(_req: ModelRequest): Promise<ModelOutput> {
    const step = this.script[this.turn] ?? { text: this.finalText };
    this.turn += 1;
    if (step.toolCalls !== undefined && step.toolCalls.length > 0) {
      return { toolCalls: step.toolCalls };
    }
    return { text: step.text ?? this.finalText };
  }
}
