import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import { WorkspaceGuard } from '../../../util/workspaceGuard.js';
import { FileContentLedger } from './fileContentLedger.js';
import { StringReplaceEditor } from './stringReplaceEditor.js';
import type { StringReplaceOutcome } from './stringReplaceEditor.js';

/** 输出预览最多回显的行数（够模型确认改对了，又不至于把上下文撑大）。 */
const MAX_PREVIEW_LINES = 6;

/**
 * 内容替换编辑工具（`edit`）：**按内容**改工作区文件，不需要模型给出行号。
 *
 * 与既有两条写路径的分工：
 * - 新建/整文件重写 ⇒ `write_file`；
 * - 拿到现成 unified diff（且来自 `git diff` 这类可信来源）⇒ `apply_patch`；
 * - **改已有代码的常规路径 ⇒ 本工具**（`old_string` → `new_string`）。
 *
 * 安全与审计：仅限工作区内；覆盖前保留 `.bak`；匹配必须**唯一**，否则拒绝并提示补充上下文，
 * 绝不做猜测性改写（细节见 {@link StringReplaceEditor}）。
 */
export class EditFileTool {
  /** 替换内核（无状态）。 */
  private readonly editor = new StringReplaceEditor();

  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: 'edit',
    description:
      '按内容精确替换工作区文件中的一段文本（推荐用于修改已有代码：无需给行号）。' +
      'old_string 必须在文件中唯一命中，否则请补充上下文或使用 replace_all。' +
      '容忍缩进与行尾空白差异。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的目标文件路径（文件须已存在）' },
        old_string: { type: 'string', description: '要被替换的原文本（须在文件中唯一）' },
        new_string: { type: 'string', description: '替换后的新文本（可为空串表示删除）' },
        replace_all: {
          type: 'boolean',
          description: 'true 时替换全部命中（默认 false，要求唯一命中）',
        },
        fuzzy: {
          type: 'boolean',
          description: '是否允许空白折叠的模糊匹配（默认 true；设 false 强制逐字符精确）',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  };

  /**
   * @param workspaceRoot 工作区根目录（编辑目标必须落在其内，越界即拒绝）。
   * @param ledger 内容账本（S1，可选）：写入前比对指纹，发现外部改动即拒绝改写。
   */
  public constructor(
    private readonly workspaceRoot: string,
    private readonly ledger?: FileContentLedger,
  ) {}

  /**
   * 执行内容替换。
   *
   * @param call 工具调用（实参含 path / old_string / new_string，可选 replace_all、fuzzy）。
   * @param _context 工具上下文（本工具未使用，忽略）。
   * @returns 成功时附替换处数与目标片段预览；路径越界 / 文件不存在 / 匹配歧义均返回失败且不写盘。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const relative = String(call.arguments['path'] ?? '');
    const oldText = String(call.arguments['old_string'] ?? '');
    const newText = String(call.arguments['new_string'] ?? '');
    const guard = new WorkspaceGuard(this.workspaceRoot);
    if (!guard.isInside(relative)) {
      return {
        callId: call.id,
        ok: false,
        error:
          `路径越界: "${relative}" 不在工作区内。工作区根目录为 ${this.workspaceRoot}，` +
          '请改用相对此根目录的路径。',
      };
    }
    const absolute = resolve(this.workspaceRoot, relative);
    try {
      const original = await readFile(absolute, 'utf8');
      // S1 冲突保护：账本有记录且磁盘内容已变 ⇒ 外部改过，先让模型重读再改。
      if (this.ledger?.changedSince(absolute, original) === true) {
        return { callId: call.id, ok: false, error: FileContentLedger.conflictMessage(relative) };
      }
      const outcome = this.editor.replace(original, {
        oldText,
        newText,
        ...(call.arguments['replace_all'] === true ? { replaceAll: true } : {}),
        ...(call.arguments['fuzzy'] === false ? { fuzzy: false } : {}),
      });
      if (!outcome.ok) {
        return { callId: call.id, ok: false, error: `${relative}: ${outcome.error ?? '替换失败'}` };
      }
      await writeFile(`${absolute}.bak`, original, 'utf8');
      await writeFile(absolute, outcome.content ?? '', 'utf8');
      this.ledger?.remember(absolute, outcome.content ?? '');
      return { callId: call.id, ok: true, output: this.report(relative, outcome, newText) };
    } catch (error) {
      return { callId: call.id, ok: false, error: this.readError(relative, error) };
    }
  }

  /**
   * 组织成功回报（处数 / 行号 / 模糊提示 / 新片段预览）。
   *
   * @param relative 目标文件相对路径。
   * @param outcome 替换结果（成功）。
   * @param newText 新文本（用于预览）。
   * @returns 可读回报文本。
   */
  private report(relative: string, outcome: StringReplaceOutcome, newText: string): string {
    const count = outcome.replacements ?? 0;
    const kind =
      outcome.matchKind === undefined || outcome.matchKind === 'exact'
        ? ''
        : outcome.matchKind === 'whitespace'
          ? '［空白折叠匹配］'
          : '［行号前缀剥离匹配］';
    const head =
      `${count === 1 ? '已替换 1 处' : `已批量替换 ${count} 处`}` +
      `（首次命中在第 ${outcome.line ?? 1} 行）: ${relative}${kind}`;
    const preview = EditFileTool.previewOf(newText);
    return preview === '' ? head : `${head}\n替换后片段：\n${preview}`;
  }

  /**
   * 把写入错误转成对模型可行动的人话（文件不存在时明确指向 `write_file`）。
   *
   * @param relative 目标文件相对路径。
   * @param error 抛出的任意值。
   * @returns 错误文案。
   */
  private readError(relative: string, error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    if (/ENOENT|no such file/i.test(detail)) {
      return `${relative} 不存在或不可读（edit 只改已存在的文件；新建请用 write_file）`;
    }
    return detail;
  }

  /**
   * 生成新文本的行预览（超过上限时附省略提示）。
   *
   * @param newText 替换后的文本。
   * @returns 预览文本；空串替换（删除）时返回空串。
   */
  private static previewOf(newText: string): string {
    if (newText === '') {
      return '（已删除该片段）';
    }
    const lines = newText.split('\n');
    const shown = lines.slice(0, MAX_PREVIEW_LINES);
    const suffix = lines.length > shown.length ? `\n… （共 ${lines.length} 行）` : '';
    return `${shown.join('\n')}${suffix}`;
  }
}
