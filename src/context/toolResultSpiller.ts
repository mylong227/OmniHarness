import type { SpillPort } from '../ports/memory/spill.js';
import type { ToolResult } from '../ports/tool/tool.js';
import { SpillPolicy, type SpillPolicyOptions } from './spillPolicy.js';

/**
 * @beta
 * 外溢器选项。
 */
export interface SpillerOptions extends SpillPolicyOptions {
  /** 豁免工具名：其输出不外溢（spill_read 读回时若再被截断，模型将永远取不回全文）。 */
  readonly exemptTools?: readonly string[];
}

/** 默认豁免：读回工具本身。 */
const DEFAULT_EXEMPT: readonly string[] = ['spill_read'];

/**
 * @beta
 * 工具结果外溢器：把超大输出换为「有界预览 + 定位符」，避免撑爆模型上下文。
 */
export class ToolResultSpiller {
  private readonly policy: SpillPolicy;
  private readonly exempt: readonly string[];

  public constructor(
    private readonly port: SpillPort,
    options: SpillerOptions,
  ) {
    this.policy = new SpillPolicy(options);
    this.exempt = options.exemptTools ?? DEFAULT_EXEMPT;
  }

  /** 未超阈值或命中豁免则原样返回；否则外溢并替换为预览 + 读回指引。 */
  public async apply(toolName: string, result: ToolResult, sessionId: string): Promise<ToolResult> {
    const target = result.output ?? result.error;
    if (this.exempt.includes(toolName) || !this.policy.needsSpill(target)) {
      return result;
    }
    const content = target as string;
    const handle = await this.port.spill(content, sessionId);
    return this.replace(result, this.render(content, handle.id, handle.bytes));
  }

  /** 用替代文本替换原输出（保持另一字段原样）。
   * @param result 原始工具结果。
   * @param text 外溢后的「有界预览 + 读回指引」文本。
   * @returns 替换后的结果（被替换的字段是**模型真正会读到的那个**，另一字段原样保留）。
   */
  private replace(result: ToolResult, text: string): ToolResult {
    const base = { callId: result.callId, ok: result.ok };
    // 失败结果必须替换 `error`：`ContextAssembler.toolContentOf` 对 ok=false 只渲染 error，
    // 原实现无条件替换 output 并把 error 丢掉 ⇒ 模型只看到「工具执行失败: 未知错误」，
    // 既丢了失败原因，也永远拿不到 spill:// 读回句柄（大输出在失败路径上必被外溢）。
    if (!result.ok && result.error !== undefined) {
      return {
        ...base,
        error: text,
        ...(result.output !== undefined ? { output: result.output } : {}),
      };
    }
    return {
      ...base,
      output: text,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  /** 渲染给模型的替代文本：有界预览 + 省略量 + 读回指引。 */
  private render(content: string, spillId: string, bytes: number): string {
    const preview = this.policy.preview(content);
    const hidden = bytes - this.policy.byteLength(preview);
    return `${preview}\n…（已省略 ${hidden} 字节，完整内容外溢至 spill://${spillId}，用 spill_read 工具传 id 读回）`;
  }
}
