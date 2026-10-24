import type { SpillPort } from '../ports/memory/spill.ts';
import type { ToolResultSpillerPort } from '../ports/context/toolResultSpillerPort.ts';
import type { ToolResult } from '../ports/tool/tool.ts';
import { SpillPolicy, type SpillPolicyOptions } from './spillPolicy.ts';
import { ObservationCompressor } from './observationCompressor.ts';

/**
 * @beta
 * 外溢器选项。
 */
export interface SpillerOptions extends SpillPolicyOptions {
  /** 豁免工具名：其输出不外溢（spill_read 读回时若再被截断，模型将永远取不回全文）。 */
  readonly exemptTools?: readonly string[];
  /**
   * 按工具的覆盖策略（可选）。
   *
   * 为什么需要：`read_file` 返回的是模型要改的代码，16 KiB 就外溢、只给 2 KiB 预览会把
   * 一个 30 KiB 文件压成约 50 行；`shell/grep` 的长输出则更适合「错误优先 + 小预览」。
   * 未列出的工具沿用全局策略（逐字旧行为）。
   */
  readonly toolPolicies?: Readonly<Record<string, SpillPolicyOptions>> | undefined;
}

/** 默认豁免：读回工具本身。 */
const DEFAULT_EXEMPT: readonly string[] = ['spill_read'];

/** 需要「错误优先」压缩预览的工具（命令/搜索输出最容易长且含失败行）。 */
const COMPRESSED_TOOLS: ReadonlySet<string> = new Set([
  'shell',
  'shell_job',
  'shell_interactive',
  'grep',
]);

/**
 * @beta
 * 工具结果外溢器：把超大输出换为「有界预览 + 定位符」，避免撑爆模型上下文。
 *
 * 契约声明见 `ports/context/toolResultSpillerPort.ts`（G25 收尾：端口归 ports，本类为其实现）。
 */
export class ToolResultSpiller implements ToolResultSpillerPort {
  private readonly policy: SpillPolicy;
  private readonly exempt: readonly string[];
  /** 按工具覆盖的策略（空 Map = 全部走全局策略）。 */
  private readonly toolPolicies: ReadonlyMap<string, SpillPolicy>;

  public constructor(
    private readonly port: SpillPort,
    options: SpillerOptions,
  ) {
    this.policy = new SpillPolicy(options);
    this.exempt = options.exemptTools ?? DEFAULT_EXEMPT;
    const perTool = new Map<string, SpillPolicy>();
    for (const [tool, override] of Object.entries(options.toolPolicies ?? {})) {
      perTool.set(tool, new SpillPolicy(override));
    }
    this.toolPolicies = perTool;
  }

  /** 未超阈值或命中豁免则原样返回；否则外溢并替换为预览 + 读回指引。 */
  public async apply(toolName: string, result: ToolResult, sessionId: string): Promise<ToolResult> {
    const target = result.output ?? result.error;
    const policy = this.toolPolicies.get(toolName) ?? this.policy;
    if (this.exempt.includes(toolName) || !policy.needsSpill(target)) {
      return result;
    }
    const content = target as string;
    const handle = await this.port.spill(content, sessionId);
    return this.replace(result, this.render(content, handle.id, handle.bytes, toolName, policy));
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

  /** 渲染给模型的替代文本：有界预览 + 省略量 + 读回指引。
   * @param content 原始内容
   * @param spillId 外溢 id
   * @param bytes 原始字节数
   * @param toolName 工具名（决定是否启用错误优先预览）
   * @param policy 该工具生效的策略（全局或按工具覆盖）
   * @returns 模型可见的预览文本
   */
  private render(
    content: string,
    spillId: string,
    bytes: number,
    toolName: string,
    policy: SpillPolicy,
  ): string {
    const source = COMPRESSED_TOOLS.has(toolName)
      ? ObservationCompressor.preview(content, {
          maxChars: Math.max(2_000, policy.preview(content).length),
        })
      : content;
    const preview = policy.preview(source);
    const hidden = bytes - policy.byteLength(preview);
    return `${preview}\n…（已省略 ${hidden} 字节，完整内容外溢至 spill://${spillId}，用 spill_read 工具传 id 读回）`;
  }
}
