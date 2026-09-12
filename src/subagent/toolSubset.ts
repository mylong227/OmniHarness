import type { ToolCall, ToolContext, ToolDefinition, ToolPort, ToolResult } from '../ports/tool.js';

/**
 * @beta
 * 受限工具端口：按白名单裁剪工具视图。
 * 既裁剪 `list()`（模型看不到未授权工具），也在 `execute()` 侧 fail-closed 拦截——
 * 双保险，模型口述出未授权工具也无法执行。
 */
export class ToolSubset implements ToolPort {
  /** 端口名：受限工具子集（subset）。 */
  public readonly name = 'subset';

  public constructor(
    private readonly inner: ToolPort,
    private readonly allowed: ReadonlySet<string>,
  ) {}

  /** 白名单内的工具定义。 */
  public list(): readonly ToolDefinition[] {
    return this.inner.list().filter((definition) => this.allowed.has(definition.name));
  }

  /** 供模型上下文的子集：白名单 ∩ 内层 listDirect（剔除 deferred 工具）。 */
  public listDirect(): readonly ToolDefinition[] {
    const inner = this.inner.listDirect?.() ?? this.inner.list();
    return inner.filter((definition) => this.allowed.has(definition.name));
  }

  /** 执行（白名单次校验）。 */
  public async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    if (!this.allowed.has(call.name)) {
      return { callId: call.id, ok: false, error: `子智能体未被授权调用工具: ${call.name}` };
    }
    return this.inner.execute(call, context);
  }

  /** 授权的工具名集合（观测用）。 */
  public allowedNames(): readonly string[] {
    return [...this.allowed];
  }
}
