import type { ToolParametersSchema } from './toolParametersSchema.js';

/** 工具定义：名称 + 描述 + 参数约束。 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParametersSchema;
  /**
   * 延迟加载：为 true 时默认不注入模型上下文（需经 `tool_search` 发现后才可见）。
   * 用于工具众多时省上下文（#M1）。缺省为 false（始终可见）。
   */
  readonly deferred?: boolean;
}
