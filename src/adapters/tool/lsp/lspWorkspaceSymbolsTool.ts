import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { LspWorkspaceSymbol, LspPort } from '../../../ports/tool/lsp.js';
import { LSP_WORKSPACE_SYMBOLS_TOOL_NAME } from '../../../adapters/lsp/lspToolNames.js';

/** 未知种类在归一化后的名字形态（`symbol#12`）与其家族前缀。 */
const UNKNOWN_KIND_PREFIX = 'symbol#';

/**
 * @beta
 * 模型面工具：在工作区范围内按名字查符号（全局符号搜索）。
 *
 * **为什么值得单独一个工具**：`lsp_document_symbols` 要求先给出**文件**，但模型最常见的起点是
 * 「只知道一个名字」——想知道某个函数/类定义在哪个文件。没有本工具时只有两条退路：
 * 盲目 `grep` 全仓（噪声大、跨语言不灵、名字对不上就漏），或逐个文件读符号目录（O(文件数) 次往返）。
 * `workspace/symbol` 让服务器用它自己的索引直接回答，一次往返拿到权威清单。
 */
export class LspWorkspaceSymbolsTool {
  /**
   * 工具定义：lsp_workspace_symbols 的名称、描述与参数 schema。
   */
  public readonly definition: ToolDefinition = {
    name: LSP_WORKSPACE_SYMBOLS_TOOL_NAME,
    description:
      '在整个工作区按名字搜索符号（函数/类/方法/变量等），返回种类、容器、文件与位置。适合在只知道符号名、不知道文件时定位定义（需已配置 LSP 服务器）。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '符号名（或名字的一部分），服务器按其索引模糊匹配。',
        },
        file: {
          type: 'string',
          description:
            '只保留位于该路径（文件或目录）下的结果，按路径段匹配：可给绝路径 / 相对路径（src）、目录（src/lsp）、文件名（a.ts）；相对写法会匹配其下的文件。缺省不过滤。',
        },
        kind: {
          type: 'string',
          description:
            '按符号种类精确过滤，取值如 file / module / class / method / function / variable / struct（缺省返回全部）。',
        },
      },
      required: ['query'],
    },
  };

  public constructor(private readonly lsp: LspPort) {}

  /**
   * 执行 lsp_workspace_symbols：解析查询串与可选过滤条件，委托 LspPort 查询后渲染。
   *
   * @param call 模型传入的工具调用（含 query，可选 file / kind）。
   * @param _context 工具执行上下文（本工具不依赖，保留签名兼容）。
   * @returns 符号清单（每行 `<kind> <name> — file:line:col`，有容器名时标注 `[在 container 中]`）；
   *   无结果显示明确提示；参数或 LSP 异常返回 ok:false。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const query = String(call.arguments['query'] ?? '').trim();
    if (query === '') {
      return { callId: call.id, ok: false, error: '缺少查询参数: query' };
    }
    const kind = String(call.arguments['kind'] ?? '').trim();
    if (kind !== '' && !LspWorkspaceSymbolsTool.validKind(kind)) {
      return { callId: call.id, ok: false, error: `kind 过滤取值非法: ${kind}` };
    }
    const file = String(call.arguments['file'] ?? '').trim();
    try {
      const symbols = (await this.lsp.workspaceSymbols?.(query)) ?? [];
      const filtered = symbols.filter(
        (symbol) =>
          (kind === '' || LspWorkspaceSymbolsTool.matchesKind(symbol.kind, kind)) &&
          (file === '' || LspWorkspaceSymbolsTool.underPath(symbol.file, file)),
      );
      if (filtered.length === 0) {
        return {
          callId: call.id,
          ok: true,
          output: LspWorkspaceSymbolsTool.emptyText(query, file),
        };
      }
      return { callId: call.id, ok: true, output: LspWorkspaceSymbolsTool.render(filtered) };
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: `LSP 全局符号查询失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * kind 是否匹配。
   *
   * 精确匹配为主：归一化后的 kind 是**封闭词表**（见 `LspSymbolKind`），全等最可预期。
   * 唯一的例外是未知数值回落成的 `symbol#<n>`——模型无从知道该填哪个 n，
   * 故 `symbol` 作为**家族前缀**接受整个回落词族（仍要求点/井号边界，不会误伤别的词）。
   *
   * @param actual 归一化后的符号种类名。
   * @param wanted 模型给出的过滤值。
   * @returns 命中为 true。
   */
  private static matchesKind(actual: string, wanted: string): boolean {
    if (actual === wanted) {
      return true;
    }
    return wanted === 'symbol' && actual.startsWith(UNKNOWN_KIND_PREFIX);
  }

  /**
   * 过滤取值是否合法（防止模型把整句话塞进 kind 导致永远空结果，却不明白为什么）。
   *
   * @param kind 模型传入的 kind 值。
   * @returns 小写字母/短横线组成的单词（或 `symbol#<n>` 形态）时为 true。
   */
  private static validKind(kind: string): boolean {
    return /^[a-z][a-z-]*$/.test(kind) || /^symbol#\d+$/.test(kind);
  }

  /**
   * 符号路径是否位于给定路径（文件或目录）之下。
   *
   * 采用**路径段序列匹配**，而不是朴素 `startsWith`：模型给的是 `src` / `src/a.ts`
   * 这类写法，服务器给的是绝对路径；字符串前缀匹配要么漏（`src` 对不上 `/repo/src/a.ts`
   * 这条**目录内**的文件），要么误（`src` 会匹配到 `srcfoo/a.ts`）。按段匹配一次性解决：
   * 过滤串的各段须在文件路径里**连续出现**，且文件过滤串必须落在路径末尾（`a.ts` 不该
   * 匹配 `deep/a.ts`，`a.ts` 也不该匹配 `a.ts.bak`）。
   *
   * 绝对路径同样落在这条规则里：`/repo/src` 的段是 `['repo','src']`，是
   * `/repo/src/a.ts` 的段序列前缀 ⇒ 命中。
   *
   * @param symbolFile 符号所属文件绝对路径。
   * @param prefix 过滤路径（文件或目录，可相对可绝对，分隔符不限）。
   * @returns 位于其下为 true；过滤串为空或全是分隔符时为 true（等于不过滤）。
   */
  private static underPath(symbolFile: string, prefix: string): boolean {
    const filter = LspWorkspaceSymbolsTool.segmentsOf(prefix);
    if (filter.length === 0) {
      return true;
    }
    return LspWorkspaceSymbolsTool.containsRun(
      LspWorkspaceSymbolsTool.segmentsOf(symbolFile),
      filter,
    );
  }

  /**
   * 把路径拆成非空路径段（分隔符统一为 `/`，连续/首尾分隔符产生的空段被丢弃）。
   *
   * @param path 原始路径。
   * @returns 路径段数组。
   */
  private static segmentsOf(path: string): readonly string[] {
    return path
      .replace(/\\/g, '/')
      .split('/')
      .filter((segment) => segment !== '');
  }

  /**
   * `filter` 的各段是否在 `file` 的段序列里**连续**出现（任意位置，按整段比较）。
   *
   * 遍历所有起点逐一比对，而不是只比末尾：过滤串既可能是文件（`src/a.ts`）、
   * 也可能是**目录**（`src`），后者在文件路径里通常不在末尾。
   * 整段比较同时挡住两类误命中：`src` 不匹配 `srcfoo`；`a.ts` 不匹配 `deep/a.ts`。
   *
   * @param file 文件路径的段序列。
   * @param filter 过滤路径的段序列（非空）。
   * @returns 命中为 true。
   */
  private static containsRun(file: readonly string[], filter: readonly string[]): boolean {
    if (filter.length > file.length) {
      return false;
    }
    for (let start = 0; start + filter.length <= file.length; start += 1) {
      if (filter.every((segment, index) => file[start + index] === segment)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 渲染符号清单：先按（文件, 行, 列, 名）排序再逐行输出。
   *
   * 为什么排序：全局清单的顺序完全由服务器索引决定，同一查询换个服务器就换一种排法。
   * 模型需要的是**稳定可复现**的阅读顺序——否则同样的工具调用两次可能给出两种上下文。
   *
   * @param symbols 过滤后的符号清单。
   * @returns 多行文本。
   */
  private static render(symbols: readonly LspWorkspaceSymbol[]): string {
    return [...symbols]
      .sort(
        (a, b) =>
          a.file.localeCompare(b.file) ||
          a.range.start.line - b.range.start.line ||
          a.range.start.character - b.range.start.character ||
          a.name.localeCompare(b.name),
      )
      .map((symbol) => {
        const { start } = symbol.range;
        const container = symbol.container !== undefined ? ` [在 ${symbol.container} 中]` : '';
        return `${symbol.kind} ${symbol.name}${container} — ${symbol.file}:${start.line}:${start.character}`;
      })
      .join('\n');
  }

  /**
   * 无结果时的可读文案。
   *
   * 过滤条件必须回显：空结果的两类原因（服务器确实没有 / 本地过滤把结果滤没了）
   * 对模型的下一步动作完全不同——前者该换查询词，后者该放宽过滤。
   *
   * @param query 查询串。
   * @param file 文件过滤（空串表示未过滤）。
   * @returns 单行提示文本。
   */
  private static emptyText(query: string, file: string): string {
    return file === '' ? `未找到符号: ${query}` : `未找到符号: ${query}（已按路径过滤: ${file}）`;
  }
}
