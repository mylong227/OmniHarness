/**
 * 文档符号归一化器：把 LSP 的两种符号编码压平成统一的 1-based 符号清单。
 *
 * ## 为什么要单独一个类
 *
 * `textDocument/documentSymbol` 有两种合法返回形态，且**取决于服务器能力**：
 * - `DocumentSymbol[]`：层级式（`name` / `kind` / `range` / `selectionRange` / `children`）；
 * - `SymbolInformation[]`：扁平式（`name` / `kind` / `location.uri` / `location.range`）。
 *
 * 把它们塞进 `LspProcessAdapter` 会让那个类越线（本仓的「上帝类」门禁按成员数计），
 * 而且这纯粹是**值的形状转换**、没有协议状态，独立成静态类最自然。
 *
 * ## 两个刻意的归一化决策
 *
 * 1. **层级压平但保留可见缩进**：模型看到的是纯文本，若压平后丢掉层级，
 *    `method` 与 `field` 的名字会糊成一片。故每层前缀两个空格。
 * 2. **优先 `selectionRange`**：`range` 覆盖整段（含文档注释与花括号），
 *    跳过去往往落在注释上；`selectionRange` 才是符号本体。二者都缺才丢掉该符号。
 */
import type {
  LspRange,
  LspSymbol,
  LspSymbolKind,
  LspWorkspaceSymbol,
} from '../../ports/tool/lsp.js';
import { LspUri } from './lspUri.js';

/** LSP `SymbolKind` 数值 → 人类可读名（未收录的数值回落 `symbol#<n>`）。 */
const SYMBOL_KIND_NAMES: Readonly<Record<number, LspSymbolKind>> = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  16: 'number',
  17: 'boolean',
  18: 'array',
  19: 'object',
  20: 'key',
  21: 'null',
  22: 'enum-member',
  23: 'struct',
  24: 'event',
  25: 'operator',
  26: 'type-parameter',
};

/** 归一化上限（服务器失控时不得炸掉上下文）。 */
const MAX_SYMBOLS = 500;

/** 文档符号归一化器（纯静态，无协议状态）。 */
export class LspSymbolNormalizer {
  /**
   * 「位置不明」时使用的占位区间（文件起点，1-based）。
   *
   * 只在服务器**给了文件 URI 却没给区间**时使用（LSP 3.17 允许）：名字与文件是真的，
   * 位置只是不精确——比把整条结果丢掉有用，也比伪造一个具体行号诚实。
   */
  private static readonly FILE_START: LspRange = {
    start: { line: 1, character: 1 },
    end: { line: 1, character: 1 },
  };

  private constructor() {}

  /**
   * 归一化 `textDocument/documentSymbol` 的返回。
   *
   * @param result 服务器原始返回（层级式 / 扁平式 / null）。
   * @param fallbackFile 结果不含 URI 时使用的文件路径（扁平式以外都缺 URI）。
   * @returns 压平后的符号清单（最多 {@link MAX_SYMBOLS} 条；形状不认识一律跳过）。
   */
  public static normalize(result: unknown, fallbackFile: string): readonly LspSymbol[] {
    const out: LspSymbol[] = [];
    for (const entry of LspSymbolNormalizer.asList(result)) {
      LspSymbolNormalizer.collect(entry, fallbackFile, 0, out);
      if (out.length >= MAX_SYMBOLS) {
        break;
      }
    }
    return out.slice(0, MAX_SYMBOLS);
  }

  /**
   * 归一化 `workspace/symbol` 的返回。
   *
   * 与 {@link LspSymbolNormalizer.normalize} 的差别不只是「不缩进」：
   * - **位置嵌套在 `location` 里**（`SymbolInformation` 与 `WorkspaceSymbol` 皆然），
   *   但 LSP 3.17 允许 `WorkspaceSymbol.location` 只有 `uri` 而没有区间 ⇒ 此时按
   *   {@link LspSymbolNormalizer.FILE_START}（文件起点）如实呈现，而不是丢掉这条结果；
   * - **`containerName` 只在这里出现**（文档符号用缩进表达层级，全局清单只能靠它）。
   *
   * 服务器返回的两种形状（`SymbolInformation[]` / `WorkspaceSymbol[]`）在本方法里走同一条路径：
   * 二者的 `name`/`kind`/`location` 字段名一致，差异（location 可选、`Location | {uri}` 二选一）
   * 由 {@link LspSymbolNormalizer.locate} 一处吸收——这也是把归一化收在本类的理由。
   *
   * @param result 服务器原始返回（`SymbolInformation[]` / `WorkspaceSymbol[]` / null）。
   * @param fallbackFile 条目连 URI 都没有时使用的回退文件（适配器传查询串占位）。
   * @returns 符号清单（最多 {@link MAX_SYMBOLS} 条；形状不认识一律跳过，绝不抛错）。
   */
  public static normalizeWorkspace(
    result: unknown,
    fallbackFile: string,
  ): readonly LspWorkspaceSymbol[] {
    const out: LspWorkspaceSymbol[] = [];
    for (const entry of LspSymbolNormalizer.asList(result)) {
      if (out.length >= MAX_SYMBOLS) {
        break;
      }
      if (entry === null || typeof entry !== 'object') {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const name = record['name'];
      if (typeof name !== 'string' || name === '') {
        continue;
      }
      const located = LspSymbolNormalizer.locate(record, fallbackFile);
      if (located === null) {
        continue;
      }
      const container = LspSymbolNormalizer.containerOf(record);
      out.push({
        name,
        kind: LspSymbolNormalizer.kindName(record['kind']),
        file: located.file,
        range: located.range,
        // exactOptionalPropertyTypes：缺容器时**不写该键**，而不是写 undefined。
        ...(container !== undefined ? { container } : {}),
      });
    }
    return out;
  }

  /**
   * 把 LSP `SymbolKind` 数值翻译成人类可读名。
   *
   * @param kind 原始 kind（可能缺失/非数）。
   * @returns 可读种类名。
   */
  public static kindName(kind: unknown): LspSymbolKind {
    if (typeof kind !== 'number' || !Number.isInteger(kind)) {
      return 'symbol#0';
    }
    return SYMBOL_KIND_NAMES[kind] ?? `symbol#${kind}`;
  }

  /**
   * 递归收集一个节点及其子节点。
   *
   * @param node 原始节点。
   * @param fallbackFile 缺 URI 时的回退文件。
   * @param depth 当前层级（决定缩进量）。
   * @param out 结果收集数组。
   * @returns 无返回值。
   */
  private static collect(
    node: unknown,
    fallbackFile: string,
    depth: number,
    out: LspSymbol[],
  ): void {
    if (node === null || typeof node !== 'object') {
      return;
    }
    const record = node as Record<string, unknown>;
    const name = record['name'];
    if (typeof name !== 'string' || name === '') {
      return;
    }
    const located = LspSymbolNormalizer.locate(record, fallbackFile);
    if (located !== null) {
      out.push({
        name: `${'  '.repeat(depth)}${name}`,
        kind: LspSymbolNormalizer.kindName(record['kind']),
        file: located.file,
        range: located.range,
      });
    }
    const children = record['children'];
    if (Array.isArray(children)) {
      for (const child of children) {
        LspSymbolNormalizer.collect(child, fallbackFile, depth + 1, out);
      }
    }
  }

  /**
   * 求出一个节点的文件与区间。
   *
   * 三处刻意的宽容 / 严谨（都是**服务器可能给出的真实输出**，丢掉即等于骗模型）：
   * 1. 区间取 `selectionRange` 优先（文档符号）→ `range` → `location.range`；
   * 2. LSP 3.17 允许 `WorkspaceSymbol.location` 只有 `uri` 而没有区间——此时用
   *    **文件起点（1:1）占位**：名字与文件是真的，位置只是不精确，比整条丢掉有用得多；
   * 3. 只有**完全没有 URI** 时才回落到 `fallbackFile`（适配器传查询串），
   *    且此时必须有区间——否则既无文件也无位置，报出去只会是假信息。
   *
   * @param record 原始节点。
   * @param fallbackFile 条目完全没给 URI 时的回退文件（如查询串占位）。
   * @returns 文件与 1-based 区间；无 URI 且无区间时为 null。
   */
  private static locate(
    record: Record<string, unknown>,
    fallbackFile: string,
  ): { readonly file: string; readonly range: LspRange } | null {
    const location = record['location'];
    const container =
      location !== null && typeof location === 'object'
        ? (location as Record<string, unknown>)
        : undefined;
    const range = record['selectionRange'] ?? record['range'] ?? container?.['range'];
    const converted = LspSymbolNormalizer.toRange(range);
    const rawUri = container?.['uri'];
    if (typeof rawUri !== 'string' || rawUri === '') {
      // 一个字节的 URI 都没有：连在哪个文件都不知道 ⇒ 只有拿到区间时才对 fallbackFile 兜底。
      return converted === null ? null : { file: fallbackFile, range: converted };
    }
    // 判据用**转换前的原始 URI**：uriToFile 对解析失败的 file:// 会原样返回，
    // 拿转换结果去 startsWith('file://') 会把这串畸形 URI 误当成合法路径。
    if (!rawUri.startsWith('file://')) {
      return converted === null ? null : { file: rawUri, range: converted };
    }
    // LSP 3.17 允许 WorkspaceSymbol 的 location 只有 uri、没有区间：用文件起点占位
    // （名字与文件是真的，位置只是不精确），比整条丢掉有用得多。
    return { file: LspUri.uriToFile(rawUri), range: converted ?? LspSymbolNormalizer.FILE_START };
  }

  /**
   * 取符号的容器名（`containerName`）。
   *
   * `SymbolInformation` 与 `WorkspaceSymbol` 都用这个**顶层**字段承载「属于哪个类/模块」；
   * 缺失、非字符串或纯空白一律返回 undefined（不给模型一串空格当信息）。
   *
   * @param record 原始符号条目。
   * @returns 非空容器名；缺失/非字符串/空白时为 undefined。
   */
  private static containerOf(record: Record<string, unknown>): string | undefined {
    const raw = record['containerName'];
    if (typeof raw !== 'string') {
      return undefined;
    }
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  /**
   * 0-based LSP 区间 → 1-based 编辑器区间。
   *
   * @param raw 原始区间。
   * @returns 转换后的区间；形状不合法为 null。
   */
  private static toRange(raw: unknown): LspRange | null {
    if (raw === null || typeof raw !== 'object') {
      return null;
    }
    const range = raw as Record<string, unknown>;
    const start = LspSymbolNormalizer.toPosition(range['start']);
    const end = LspSymbolNormalizer.toPosition(range['end']);
    return start === null || end === null ? null : { start, end };
  }

  /**
   * 0-based 位置 → 1-based 位置。
   *
   * @param raw 原始位置。
   * @returns 转换后的位置；形状不合法为 null。
   */
  private static toPosition(
    raw: unknown,
  ): { readonly line: number; readonly character: number } | null {
    if (raw === null || typeof raw !== 'object') {
      return null;
    }
    const position = raw as Record<string, unknown>;
    const line = position['line'];
    const character = position['character'];
    if (typeof line !== 'number' || typeof character !== 'number') {
      return null;
    }
    return { line: line + 1, character: character + 1 };
  }

  /**
   * 把结果包成数组（null/undefined → 空数组）。
   *
   * @param result 原始返回。
   * @returns 数组形式。
   */
  private static asList(result: unknown): readonly unknown[] {
    if (result === null || result === undefined) {
      return [];
    }
    return Array.isArray(result) ? result : [result];
  }
}
