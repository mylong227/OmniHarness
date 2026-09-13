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

  /** 已注册工具表：工具名 → 定义与处理器的映射。 */
  private readonly tools = new Map<string, RegisteredTool>();

  /** 注册一个工具；重名即抛错。
   * @param definition 工具定义（名称、描述与 JSON Schema 参数）。
   * @param handler 该工具的执行处理器。
   * @returns 无返回值。
   */
  public register(definition: ToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`工具重复注册: ${definition.name}`);
    }
    this.tools.set(definition.name, { definition, handler });
  }

  /** 全部工具定义。
   * @returns 所有已注册工具的定义列表（按注册顺序）。
   */
  public list(): readonly ToolDefinition[] {
    return [...this.tools.values()].map((entry) => entry.definition);
  }

  /** 反注册工具（插件卸载回收用）；不存在返回 false。
   * @param name 要反注册的工具名。
   * @returns 工具存在且已删除时为 true，否则为 false。
   */
  public unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** 供模型上下文的子集：剔除 deferred 工具（#M1 延迟加载）。
   * @returns 非 deferred 工具的定义列表。
   */
  public listDirect(): readonly ToolDefinition[] {
    return this.list().filter((definition) => definition.deferred !== true);
  }

  /** 将指定工具标记为延迟加载（deferred）。未知名忽略。
   * @param names 要标记为 deferred 的工具名列表。
   * @returns 无返回值。
   */
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

  /** 执行工具调用（校验 → 分发 → 兜底错误）。
   * @param call 模型发起的工具调用（工具名与实参）。
   * @param context 本次调用的上下文（取消信号、审批端口等）。
   * @returns 工具执行结果；未知工具、校验失败或处理器抛错时返回失败结果而不抛异常。
   */
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

  /** 校验调用参数（必填 + 类型）。
   * @param call 待校验的工具调用实参。
   * @param definition 目标工具定义（含参数 Schema）。
   * @returns 校验通过返回空字符串，否则返回首条错误的中文描述。
   */
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

  /** 判断实参是否符合期望类型（array/null 无法由 typeof 区分，须特判）。
   * @param value 待判断的实参值。
   * @param expected Schema 期望的类型名（如 'string'、'array'）。
   * @returns 实参类型与期望一致时为 true，否则为 false。
   */
  private matchesType(value: unknown, expected: string): boolean {
    if (expected === 'array') {
      return Array.isArray(value);
    }
    return typeof value === expected;
  }

  /** 实参的实际类型名（错误信息用，array/null 同样需特判）。
   * @param value 待探测类型的值。
   * @returns 值的类型名（'array'、'null' 或 typeof 结果）。
   */
  private typeNameOf(value: unknown): string {
    if (Array.isArray(value)) {
      return 'array';
    }
    if (value === null) {
      return 'null';
    }
    return typeof value;
  }

  /** 提取属性的期望类型。
   * @param raw Schema 中某属性的定义（可能是任意结构）。
   * @returns 属性声明的类型名；无对象结构或无字符串 type 时为 undefined（不校验）。
   */
  private expectedType(raw: unknown): string | undefined {
    if (typeof raw !== 'object' || raw === null || !('type' in raw)) {
      return undefined;
    }
    return typeof raw.type === 'string' ? raw.type : undefined;
  }

  /** 构造失败结果。
   * @param callId 对应的工具调用 ID（用于结果与调用配对）。
   * @param error 面向模型的错误描述。
   * @returns ok=false 的工具结果。
   */
  private failure(callId: string, error: string): ToolResult {
    return { callId, ok: false, error };
  }

  /** 提取错误消息。
   * @param error 处理器抛出的任意值。
   * @returns Error 实例取其 message，其余值转字符串。
   */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
