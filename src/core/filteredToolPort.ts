import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolPort,
  ToolResult,
} from '../ports/tool/tool.js';

/**
 * 受限工具端口：在基端口之上按谓词过滤工具视图。
 *
 * - `list()` 只返回放行项，使受控视图（对等委托 / 子代）看不到越权工具；
 * - `execute()` 对未放行项 fail-closed 拒绝（不静默转发到基端口），避免受限子集被绕过。
 *
 * 典型用途：把 `MUTATING_TOOLS`（写类 / 危险工具）从委托给对等方或子代的工具面中剔除
 * （详见 {@link A2aTaskExecutor}）。
 */
export class FilteredToolPort implements ToolPort {
  /** 端口名（调试标识）。 */
  public readonly name = 'filtered';

  /**
   * 构造受限工具端口。
   * @param base 被过滤的基工具端口
   * @param allow 工具名放行谓词（返回 true 表示该工具在受限视图中可见可用）
   */
  public constructor(
    private readonly base: ToolPort,
    private readonly allow: (name: string) => boolean,
  ) {}

  /**
   * 受限视图内的工具定义列表（已剔除未放行项）。
   * @returns 已放行工具的定义列表
   */
  public list(): readonly ToolDefinition[] {
    return this.base.list().filter((def) => this.allow(def.name));
  }

  /**
   * 执行工具调用：未放行项 fail-closed 拒绝（不转发基端口）。
   * @param call 工具调用
   * @param context 执行上下文
   * @returns 未放行时返回 ok:false 并带原因；否则委托基端口执行
   */
  public async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    if (!this.allow(call.name)) {
      return {
        callId: call.id,
        ok: false,
        error: `工具 ${call.name} 不在受限子集内（受限视图 fail-closed 拒绝）`,
      };
    }
    return this.base.execute(call, context);
  }

  /**
   * 延迟加载子集：缺失时回退受限 list。
   * @returns 已放行工具的定义列表（与 {@link FilteredToolPort.list} 同视图）
   */
  public listDirect(): readonly ToolDefinition[] {
    return this.base.listDirect?.() ?? this.list();
  }

  /**
   * 反注册：委托基端口（若存在）。
   * @param name 待反注册工具名
   * @returns 基端口是否成功反注册（基端口无该方法时返回 false）
   */
  public unregister(name: string): boolean {
    return this.base.unregister?.(name) ?? false;
  }
}
