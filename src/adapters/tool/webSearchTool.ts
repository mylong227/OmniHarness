import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';

/** 网络搜索工具选项（注入真实搜索实现，保持零依赖）。 */
export interface WebSearchToolOptions {
  readonly search?: (query: string) => Promise<string>;
}

/** 网络搜索工具：可注入搜索实现，未配置时明确提示（不静默失败）。 */
export class WebSearchTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: 'web_search',
    description: '搜索网络并返回结果摘要',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
      },
      required: ['query'],
    },
  };

  public constructor(private readonly options: WebSearchToolOptions = {}) {}

  /** 执行搜索。 */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const query = String(call.arguments['query'] ?? '');
    const search = this.options.search;
    if (search === undefined) {
      return { callId: call.id, ok: false, error: '未配置搜索服务（构造时注入 search 实现）' };
    }
    try {
      const output = await search(query);
      return { callId: call.id, ok: true, output };
    } catch (error) {
      return { callId: call.id, ok: false, error: this.messageOf(error) };
    }
  }

  /** 提取错误消息。 */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
