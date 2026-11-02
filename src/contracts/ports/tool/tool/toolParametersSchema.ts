/** 工具参数 JSON Schema 最小子集。 */
export interface ToolParametersSchema {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
}
