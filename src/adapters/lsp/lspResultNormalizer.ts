/**
 * LSP 结果归一化器：把导航/悬停/文档同步三处的**纯值形状转换**从 `LspProcessAdapter` 抽出。
 *
 * ## 为什么要单独一个类
 *
 * 这三件事与协议状态无关，只做「上游形状 → 本适配器形状」的翻译：
 * - `textDocument/definition|references` 的 `Location | Location[] | LocationLink[] | null`；
 * - `textDocument/hover` 的 `string | MarkupContent | MarkedString[]`；
 * - `didOpen` 需要的 `languageId`（由扩展名查表）。
 *
 * 抽出前 `LspProcessAdapter` 已达 27 个方法（>25 判「上帝类」），而这三个方法又恰恰是
 * 与连接/进程生命周期完全无关的纯函数——独立成静态类既守住成员数上限，也让它们可被单测直接覆盖
 * （无需 spawn 语言服务器）。与 `LspSymbolNormalizer` / `LspCodeActionNormalizer` 同一模式。
 *
 * ## 两条纪律
 *
 * 1. **坐标转换只在边界发生一次**：LSP 是 0-based，编辑器/工具是 1-based；本类只做 +1，不做裁剪，
 *    越界坐标原样返回（是否合法由调用方/服务器判定，猜测会掩盖真实错误）。
 * 2. **不认识的形状一律剔除**：宁可少给一条位置，也不抛错中断整批结果。
 */
import type { LspLocation } from '../../ports/tool/lsp.js';
import { LspUri } from './lspUri.js';

/** 扩展名 → LSP `languageId` 查表（未收录的回退 `plaintext`）。 */
const LANGUAGE_IDS: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  md: 'markdown',
  sh: 'shellscript',
  yml: 'yaml',
  yaml: 'yaml',
};

/** LSP 原始结果归一化器（纯静态，无协议状态）。 */
export class LspResultNormalizer {
  private constructor() {}

  /**
   * LSP Location（0-based）→ 适配器 {@link LspLocation}（1-based）。
   *
   * @param result 服务器原始返回（单个 Location、Location 数组或 null/undefined）。
   * @returns 转换后的位置列表（URI 转回文件路径、坐标 +1）；非法条目被逐个剔除。
   */
  public static toLocations(result: unknown): LspLocation[] {
    if (result === null || result === undefined) {
      return [];
    }
    const list = Array.isArray(result) ? result : [result];
    const out: LspLocation[] = [];
    for (const item of list) {
      if (item !== null && typeof item === 'object' && 'uri' in item && 'range' in item) {
        const loc = item as {
          uri: string;
          range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
        };
        out.push({
          uri: LspUri.uriToFile(loc.uri),
          range: {
            start: { line: loc.range.start.line + 1, character: loc.range.start.character + 1 },
            end: { line: loc.range.end.line + 1, character: loc.range.end.character + 1 },
          },
        });
      }
    }
    return out;
  }

  /**
   * 悬停返回值归一化：兼容 `string` / `MarkupContent` / `MarkedString[]` 三种形态。
   *
   * @param result textDocument/hover 的原始返回。
   * @returns 拼接后的悬停文本（数组条目以换行相连）；无 contents 或形态不识别时为 undefined。
   */
  public static hoverText(result: unknown): string | undefined {
    if (result === null || typeof result !== 'object') {
      return undefined;
    }
    const contents = (result as { contents?: unknown }).contents;
    if (contents === undefined) {
      return undefined;
    }
    if (typeof contents === 'string') {
      return contents;
    }
    if (Array.isArray(contents)) {
      return contents
        .map((entry) =>
          typeof entry === 'string'
            ? entry
            : entry !== null && typeof entry === 'object' && 'value' in entry
              ? String((entry as { value: unknown }).value)
              : '',
        )
        .join('\n');
    }
    if (contents !== null && typeof contents === 'object' && 'value' in contents) {
      return String((contents as { value: unknown }).value);
    }
    return undefined;
  }

  /**
   * 由扩展名推断 LSP `languageId`。
   *
   * @param file 文件路径（取最后一个点后的扩展名，大小写不敏感）。
   * @returns 查表得到的 languageId；未知扩展名回退 `plaintext`。
   */
  public static languageId(file: string): string {
    const dot = file.lastIndexOf('.');
    const ext = dot >= 0 ? file.slice(dot + 1).toLowerCase() : '';
    return LANGUAGE_IDS[ext] ?? 'plaintext';
  }
}
