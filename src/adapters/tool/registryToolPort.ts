import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolPort,
  ToolResult,
} from '../../ports/tool.js';
import type { ToolHandler } from './toolHandler.js';

/** 已注册工具：定义 + 处理函数。 */
interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
}

/** 工具聚合适配器：把多个工具定义+处理器组装成一个 ToolPort（可注册/替换/扩展）。 */
export class RegistryToolPort implements ToolPort {
  /**
   * 端口标识：本聚合适配器在审批/日志中的名称（固定为 'registry'）。
   * 仅用于后端区分与可观测，不参与工具匹配逻辑。
   */
  public readonly name = 'registry';

  private readonly tools = new Map<string, RegisteredTool>();

  /** 注册一个工具；重名即抛错。 */
  public register(definition: ToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`工具重复注册: ${definition.name}`);
    }
    this.tools.set(definition.name, { definition, handler });
  }

  /** 全部工具定义。 */
  public list(): readonly ToolDefinition[] {
    return [...this.tools.values()].map((entry) => entry.definition);
  }

  /** 反注册工具（插件卸载回收用）；不存在返回 false。 */
  public unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** 供模型上下文的子集：剔除 deferred 工具（#M1 延迟加载）。 */
  public listDirect(): readonly ToolDefinition[] {
    return this.list().filter((definition) => definition.deferred !== true);
  }

  /** 将指定工具标记为延迟加载（deferred）。未知名忽略。 */
  public markDeferred(names: readonly string[]): void {
    const deferredSet = new Set(names);
    for (const name of deferredSet) {
      const entry = this.tools.get(name);
      if (entry === undefined) {
        continue;
      }
      this.tools.set(name, {
        definition: { ...entry.definition, deferred: true },
        handler: entry.handler,
      });
    }
  }

  /** 执行工具调用（校验 → 分发 → 兜底错误）。 */
  public async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const entry = this.tools.get(call.name);
    if (entry === undefined) {
      return this.failure(call.id, `未知工具: ${call.name}`);
    }
    const validationError = this.validate(call, entry.definition);
    if (validationError !== '') {
      return this.failure(call.id, validationError);
    }
    try {
      return await entry.handler(call, context);
    } catch (error) {
      return this.failure(call.id, this.messageOf(error));
    }
  }

  /** 校验调用参数（必填 + 类型）。 */
  private validate(call: ToolCall, definition: ToolDefinition): string {
    const schema = definition.parameters;
    for (const key of schema.required ?? []) {
      if (!(key in call.arguments)) {
        return `缺少必填参数: ${key}`;
      }
    }
    for (const key of Object.keys(call.arguments)) {
      const expected = this.expectedType(schema.properties[key]);
      if (expected === undefined) {
        continue;
      }
      if (!this.matchesType(call.arguments[key], expected)) {
        return `参数 ${key} 类型不符: 期望 ${expected}, 实际 ${this.typeNameOf(call.arguments[key])}`;
      }
    }
    return '';
  }

  /** 判断实参是否符合期望类型（array/null 无法由 typeof 区分，须特判）。 */
  private matchesType(value: unknown, expected: string): boolean {
    if (expected === 'array') {
      return Array.isArray(value);
    }
    return typeof value === expected;
  }

  /** 实参的实际类型名（错误信息用，array/null 同样需特判）。 */
  private typeNameOf(value: unknown): string {
    if (Array.isArray(value)) {
      return 'array';
    }
    if (value === null) {
      return 'null';
    }
    return typeof value;
  }

  /** 提取属性的期望类型。 */
  private expectedType(raw: unknown): string | undefined {
    if (typeof raw !== 'object' || raw === null || !('type' in raw)) {
      return undefined;
    }
    return typeof raw.type === 'string' ? raw.type : undefined;
  }

  /** 构造失败结果。 */
  private failure(callId: string, error: string): ToolResult {
    return { callId, ok: false, error };
  }

  /** 提取错误消息。 */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
