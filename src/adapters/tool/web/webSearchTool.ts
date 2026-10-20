import { TOOL_NAMES } from '../../../ports/tool/toolNames.ts'
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../../ports/tool/tool.ts';
import type { WebSearchProvider } from '../../../ports/tool/webSearchProvider.ts';

/** 网络搜索工具选项（注入真实搜索实现，保持无第三方依赖）。 */
export interface WebSearchToolOptions {
  /** 搜索实现：关键词 → 结果摘要；未注入时工具明确报错不静默失败。 */
  readonly search?: (query: string) => Promise<string>;
  /** 结构化 provider（优先于 `search`；ACT-02）。 */
  readonly provider?: WebSearchProvider | undefined;
}

/** 网络搜索工具：可注入搜索实现，未配置时明确提示（不静默失败）。 */
export class WebSearchTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.webSearch,
    description: '搜索网络并返回结果摘要',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
      },
      required: ['query'],
    },
  };

  /**
   * @param options 工具选项（可注入搜索实现）。
   */
  public constructor(private readonly options: WebSearchToolOptions = {}) {}

  /** 执行搜索。
   * @param call 工具调用（实参含 query）。
   * @param _context 工具上下文（本工具未使用，忽略）。
   * @returns 执行结果：成功附搜索摘要；未配置实现或搜索异常返回失败。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const query = String(call.arguments['query'] ?? '');
    const provider = this.options.provider;
    if (provider !== undefined) {
      try {
        const results = await provider.search(query);
        if (results.length === 0) {
          return { callId: call.id, ok: true, output: '（没有搜索结果）' };
        }
        return {
          callId: call.id,
          ok: true,
          output: results
            .map(
              (result, index) =>
                `${String(index + 1)}. ${result.title}\n   ${result.url}${
                  result.snippet === undefined || result.snippet === ''
                    ? ''
                    : `\n   ${result.snippet}`
                }`,
            )
            .join('\n'),
        };
      } catch (error) {
        return { callId: call.id, ok: false, error: this.messageOf(error) };
      }
    }
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

  /** 提取错误消息。
   * @param error 抛出的任意值。
   * @returns Error 取 message，其余转字符串。
   */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
