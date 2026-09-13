import type { ToolDefinition } from '../ports/tool/tool.js';
import { Bm25Index, tokenize } from './bm25Index.js';

/**
 * @beta
 * 工具语义检索引擎（#M1）：BM25 索引工具名 / 描述 / 参数，
 * 按自然语言查询返回最相关工具定义（top-K）。
 */
export class ToolIndex {
  private tools: readonly ToolDefinition[];
  private index: Bm25Index;

  public constructor(tools: readonly ToolDefinition[]) {
    this.tools = [...tools];
    this.index = this.build(this.tools);
  }

  /** 重建索引（工具集变化后调用，如热加载新工具）。
   * @returns 无返回值。
   */
  public reindex(tools: readonly ToolDefinition[]): void {
    this.tools = [...tools];
    this.index = this.build(this.tools);
  }

  /** 检索：返回排序后的工具定义（top-K）。空查询返回空数组。 */
  public search(query: string, limit: number): ToolDefinition[] {
    const trimmed = query.trim();
    if (trimmed === '') {
      return [];
    }
    const hits = this.index.search(tokenize(trimmed), Math.max(1, limit));
    const result: ToolDefinition[] = [];
    for (const hit of hits) {
      const tool = this.tools[hit.id];
      if (tool !== undefined) {
        result.push(tool);
      }
    }
    return result;
  }

  /** 当前索引的工具数。 */
  public get size(): number {
    return this.tools.length;
  }

  private build(tools: readonly ToolDefinition[]): Bm25Index {
    const index = new Bm25Index();
    index.addDocuments(tools.map((tool) => tokenize(this.searchableText(tool))));
    return index;
  }

  /** 可检索文本：工具名（含空格化形式）+ 描述 + 各参数名与描述。 */
  private searchableText(tool: ToolDefinition): string {
    const parts: string[] = [tool.name, tool.name.replace(/_/g, ' '), tool.description];
    for (const value of Object.values(tool.parameters.properties)) {
      if (typeof value !== 'object' || value === null) {
        continue;
      }
      const record = value as Record<string, unknown>;
      if (typeof record.description === 'string') {
        parts.push(record.description);
      }
    }
    return parts.join(' ');
  }
}
