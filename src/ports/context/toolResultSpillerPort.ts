import type { ToolResult } from '../tool/tool.js';

/**
 * 工具结果外溢器端口（G25 收尾，2026-10-04 第三十轮）。
 *
 * 原 `CorePorts.spiller` / `ResolvedConfig.spiller` / `OmniHarnessRuntime.spiller` 绑定在
 * context 层实现类 `ToolResultSpiller` 上——端口契约被绑死在具体类型，构成 ports→context 的
 * 隐性实现依赖（门禁 [3.5] 当时只覆盖 core/adapters/config/composition，`context/`/`search/`
 * 是漏网层）。抽到端口后，`ports/config/**`、`ports/composition/**`、`core/stepTypes` 仅依赖
 * 本接口；实现类 `ToolResultSpiller` `implements` 本接口，实例仍由组合根装配。
 */
export interface ToolResultSpillerPort {
  /**
   * 未超阈值或命中豁免则原样返回；否则外溢并替换为「有界预览 + 定位符」。
   * @param toolName 工具名（豁免表按名匹配，默认豁免 `spill_read` 本身）。
   * @param result 工具执行结果。
   * @param sessionId 会话 id（外溢句柄归属）。
   * @returns 可能被替换的结果——失败结果替换 `error`、成功结果替换 `output`
   *   （被替换的字段是 `ContextAssembler` 真正渲染给模型的那个），另一字段原样保留。
   */
  apply(toolName: string, result: ToolResult, sessionId: string): Promise<ToolResult>;
}
