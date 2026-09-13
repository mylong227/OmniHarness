import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import { ToolIndex } from '../../search/toolIndex.js';
import { ToolDiscovery } from '../../search/toolDiscovery.js';

/** tool_search 默认返回工具数上限。 */
const DEFAULT_LIMIT = 5;

/**
 * @beta
 * 工具语义检索工具（#M1）：模型用自然语言查询最相关工具 schema，按需「装载」而非全量注入。
 * 命中结果同时登记进 `ToolDiscovery`，使被延迟加载（deferred）的工具在后续回合对模型可见、可被调用。
 */
export class ToolSearchTool {
  /**
   * 工具定义：tool_search 工具的名称、描述与参数 schema。
   * 按自然语言检索最相关工具 schema；被延迟加载工具经本工具发现后后续回合可见、可调用。
   */
  public readonly definition: ToolDefinition = {
    name: 'tool_search',
    description:
      '当工具众多时，按自然语言查询检索最相关的工具定义（名称 / 描述 / 参数 schema）。返回命中工具的完整 schema，模型据此决定如何调用；被标记为「延迟加载(deferred)」的工具默认不在上下文，需先经本工具发现。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            '自然语言查询，如「如何读取文件」「怎么执行 shell 命令」「发送 HTTP 请求用哪个工具」',
        },
        limit: { type: 'number', description: '返回工具数上限（默认 5）' },
      },
      required: ['query'],
    },
  };

  /**
   * @param index 工具语义索引（BM25 打分检索工具 schema）。
   * @param discovery 发现登记表：命中工具（含 deferred）登记后对后续回合可见。
   */
  public constructor(
    private readonly index: ToolIndex,
    private readonly discovery: ToolDiscovery,
  ) {}

  /** 执行检索并登记命中 schema 供后续回合装载。
   * @param call 工具调用（实参含 query，可选 limit）。
   * @param _context 工具上下文（本工具未使用，忽略）。
   * @returns 执行结果：JSON 文本含命中数与各工具（名称/描述/schema/是否 deferred）；query 为空返回失败。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const query = String(call.arguments['query'] ?? '').trim();
    if (query === '') {
      return { callId: call.id, ok: false, error: 'query 不能为空' };
    }
    const limit =
      typeof call.arguments['limit'] === 'number'
        ? Math.max(1, Math.floor(call.arguments['limit'] as number))
        : DEFAULT_LIMIT;
    const hits = this.index.search(query, limit);
    this.discovery.add(hits);
    const payload = hits.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      deferred: tool.deferred === true,
    }));
    return {
      callId: call.id,
      ok: true,
      output: JSON.stringify({ count: hits.length, tools: payload }, null, 2),
    };
  }
}
