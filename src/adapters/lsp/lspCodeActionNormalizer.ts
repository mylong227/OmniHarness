/**
 * 代码操作归一化器：把 LSP 的两种编辑编码压平成统一的文本编辑清单。
 *
 * ## 为什么要单独一个类
 *
 * `textDocument/codeAction` 的返回里有三种互不相同的形状，且**同一条操作里可能混用**：
 * - `{ title, kind, isPreferred, edit }` —— 带工作区编辑（真正的快速修复）；
 * - `{ title, command }` —— 只有一个命令，需要服务器/客户端侧执行才有副作用；
 * - `edit` 内部又分 `changes`（`{uri: TextEdit[]}`）与 `documentChanges`
 *   （`TextDocumentEdit[] | CreateFile | RenameFile | DeleteFile` 的混合数组）。
 *
 * 上层（工具渲染、未来的「应用修复」能力）只应面对一种形状。转换是纯值操作、
 * 无协议状态，独立成静态类，也避免把 `LspProcessAdapter` 推过成员数上限。
 *
 * ## 两条纪律
 *
 * 1. **只呈现，不下写**：本类产出「改哪儿、改成什么」，绝不触碰文件系统。
 *    自动应用代码操作属于写权限范畴，必须由上层经审批/沙箱后决定。
 * 2. **有界**：操作数与每条操作的编辑数都封顶。语言服务器在超大文件上给出的
 *    重构编辑可达数万条，全量渲染会瞬间吃光上下文。
 */
import type { LspCodeAction, LspRange, LspTextEdit } from '../../ports/tool/lsp.js';
import { LspUri } from './lspUri.js';

/** 最多保留的操作数。 */
const MAX_ACTIONS = 50;

/** 单条操作最多保留的编辑数。 */
const MAX_EDITS_PER_ACTION = 20;

/** 代码操作归一化器（纯静态，无协议状态）。 */
export class LspCodeActionNormalizer {
  private constructor() {}

  /**
   * 归一化 `textDocument/codeAction` 的返回。
   *
   * @param result 服务器原始返回（数组 / 单个 / null）。
   * @returns 归一化后的操作清单（形状不认识的条目被跳过，不抛错）。
   */
  public static normalize(result: unknown): readonly LspCodeAction[] {
    const out: LspCodeAction[] = [];
    for (const raw of LspCodeActionNormalizer.asList(result)) {
      if (out.length >= MAX_ACTIONS) {
        break;
      }
      const action = LspCodeActionNormalizer.toAction(raw);
      if (action !== null) {
        out.push(action);
      }
    }
    return out;
  }

  /**
   * 把单条原始操作转成 {@link LspCodeAction}。
   *
   * @param raw 原始条目。
   * @returns 归一化结果；形状不认识为 null。
   */
  private static toAction(raw: unknown): LspCodeAction | null {
    if (raw === null || typeof raw !== 'object') {
      return null;
    }
    const record = raw as Record<string, unknown>;
    const title = record['title'];
    if (typeof title !== 'string' || title.trim() === '') {
      return null;
    }
    const kind = record['kind'];
    return {
      title: title.trim(),
      kind: typeof kind === 'string' && kind !== '' ? kind : undefined,
      isPreferred: record['isPreferred'] === true,
      edits: LspCodeActionNormalizer.editsOf(record['edit']),
    };
  }

  /**
   * 压平一个 `WorkspaceEdit`。
   *
   * @param edit 原始 `edit` 字段。
   * @returns 文本编辑列表（无编辑或形状不认识为空数组）。
   */
  private static editsOf(edit: unknown): readonly LspTextEdit[] {
    if (edit === null || typeof edit !== 'object') {
      return [];
    }
    const record = edit as Record<string, unknown>;
    const out: LspTextEdit[] = [];
    LspCodeActionNormalizer.pushChanges(record['changes'], out);
    LspCodeActionNormalizer.pushDocumentChanges(record['documentChanges'], out);
    return out.slice(0, MAX_EDITS_PER_ACTION);
  }

  /**
   * 处理 `changes`（`{uri: TextEdit[]}`）。
   *
   * @param changes 原始字段。
   * @param out 结果收集数组。
   * @returns 无返回值。
   */
  private static pushChanges(changes: unknown, out: LspTextEdit[]): void {
    if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
      return;
    }
    for (const [uri, edits] of Object.entries(changes as Record<string, unknown>)) {
      LspCodeActionNormalizer.pushEdits(LspUri.uriToFile(uri), edits, out);
    }
  }

  /**
   * 处理 `documentChanges`（`TextDocumentEdit[]` 与文件操作混排）。
   *
   * 只取带 `textDocument.uri` + `edits` 的条目；`create`/`rename`/`delete` 这类
   * 文件级操作**不在本层表达**（它们不是文本编辑），跳过而不是硬塞成空编辑，
   * 免得让上层以为「这条操作没有改动」。
   *
   * @param documentChanges 原始字段。
   * @param out 结果收集数组。
   * @returns 无返回值。
   */
  private static pushDocumentChanges(documentChanges: unknown, out: LspTextEdit[]): void {
    if (!Array.isArray(documentChanges)) {
      return;
    }
    for (const entry of documentChanges) {
      if (entry === null || typeof entry !== 'object') {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const textDocument = record['textDocument'];
      if (textDocument === null || typeof textDocument !== 'object') {
        continue;
      }
      const uri = (textDocument as Record<string, unknown>)['uri'];
      if (typeof uri !== 'string' || uri === '') {
        continue;
      }
      LspCodeActionNormalizer.pushEdits(LspUri.uriToFile(uri), record['edits'], out);
    }
  }

  /**
   * 把一组 `TextEdit` 转成 {@link LspTextEdit}。
   *
   * @param file 目标文件路径。
   * @param edits 原始编辑数组。
   * @param out 结果收集数组。
   * @returns 无返回值。
   */
  private static pushEdits(file: string, edits: unknown, out: LspTextEdit[]): void {
    if (!Array.isArray(edits)) {
      return;
    }
    for (const edit of edits) {
      if (out.length >= MAX_EDITS_PER_ACTION) {
        return;
      }
      const converted = LspCodeActionNormalizer.toTextEdit(file, edit);
      if (converted !== null) {
        out.push(converted);
      }
    }
  }

  /**
   * 转换单条 `TextEdit`。
   *
   * @param file 目标文件路径。
   * @param raw 原始条目。
   * @returns 文本编辑；形状不合法为 null。
   */
  private static toTextEdit(file: string, raw: unknown): LspTextEdit | null {
    if (raw === null || typeof raw !== 'object') {
      return null;
    }
    const record = raw as Record<string, unknown>;
    const newText = record['newText'];
    const range = LspCodeActionNormalizer.toRange(record['range']);
    if (typeof newText !== 'string' || range === null) {
      return null;
    }
    return { file, range, newText };
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
    const start = LspCodeActionNormalizer.toPosition(range['start']);
    const end = LspCodeActionNormalizer.toPosition(range['end']);
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
   * 把结果包成数组。
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
