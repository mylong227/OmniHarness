/** 模型返回的工具调用引用。 */
export interface ModelToolCallRef {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
