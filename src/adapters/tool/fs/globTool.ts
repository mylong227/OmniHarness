import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import { GlobMatcher } from '../../../util/globMatcher.js';
import { WorkspaceFileWalker } from '../../../util/workspaceFileWalker.js';
import { WorkspaceGuard } from '../../../util/workspaceGuard.js';

/**
 * 内置 `glob` 工具（无第三方依赖，纯 TS）：按通配符找文件。
 *
 * 与 `grep` 的分工：`grep` 按**内容**找，`glob` 按**路径**找；两者组合即可覆盖
 * 「查问题」时最常见的两类检索（「谁引用了 X」 vs 「这个目录下有哪些测试文件」）。
 *
 * 输出**字典序**（复用 {@link WorkspaceFileWalker} 的确定性排序），
 * 同一工作区两次调用逐字相同 ⇒ 可作为断言基线与可复现的推理依据。
 */
export class GlobTool {
  /** 默认命中上限。 */
  public static readonly DEFAULT_MAX_RESULTS = 200;

  /** 命中上限的硬上界。 */
  public static readonly MAX_RESULTS_LIMIT = 5000;

  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.glob,
    description:
      '按通配符在工作区内查找文件路径（支持 **、{a,b}、[abc]；自动忽略 .git/node_modules/构建产物）。' +
      '结果按字典序稳定输出。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '路径通配符，如 `src/**/*.ts`、`**/*.test.mjs`、`*.{js,ts}`',
        },
        path: { type: 'string', description: '限定搜索的子目录（相对工作区；缺省为整个工作区）' },
        max_results: {
          type: 'number',
          description: `返回上限（默认 ${GlobTool.DEFAULT_MAX_RESULTS}，硬上界 ${GlobTool.MAX_RESULTS_LIMIT}）`,
        },
        include_hidden: { type: 'boolean', description: '是否包含点文件/点目录（默认 false）' },
      },
      required: ['pattern'],
    },
  };

  /**
   * @param workspaceRoot 工作区根目录（搜索范围与路径白名单基准）。
   * @param walkMaxFiles 遍历文件数上限（可选；缺省用 `WorkspaceFileWalker` 的默认值）。
   *
   * **为什么需要这个缝**：本工具的「截断 + 零命中 ⇒ fail-loud」分支只在**超大工作区**才可达
   * （2026-10-06 是在真实仓库里偶发撞到的：`third-party/` 近 2 万文件把上限吃满，根本没走到 `src/`）。
   * 没有这个缝，那条判据就只能靠"真实仓库偶发命中"，无法落库；有了它，判据可以用
   * 「3 个文件的工作区 + 上限 1」确定性地构造出来。
   */
  public constructor(
    private readonly workspaceRoot: string,
    private readonly walkMaxFiles?: number,
  ) {}

  /**
   * 执行查找。
   *
   * @param call 工具调用（实参见 {@link GlobTool.definition}）。
   * @param context 工具上下文（workspaceRoot 优先，支持会话级切换工作区）。
   * @returns 相对路径清单 + 统计脚注；pattern 为空 / 路径越界 / 子目录不存在时返回失败。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const pattern = String(call.arguments['pattern'] ?? '');
    if (pattern === '') {
      return { callId: call.id, ok: false, error: 'pattern 不能为空' };
    }
    const root = context.workspaceRoot === '' ? this.workspaceRoot : context.workspaceRoot;
    const subdir = String(call.arguments['path'] ?? '');
    const guard = new WorkspaceGuard(root);
    if (subdir !== '' && subdir !== '.' && !guard.isInside(subdir)) {
      return { callId: call.id, ok: false, error: `路径越界: "${subdir}" 不在工作区内` };
    }
    const scope = await GlobTool.normalizeSubdir(root, subdir);
    if (scope === undefined) {
      return { callId: call.id, ok: false, error: `路径不存在: ${subdir}` };
    }
    const limit = GlobTool.clampMaxResults(call.arguments['max_results']);
    const matcher = new GlobMatcher(pattern);
    // 带目录前缀的模式（`src/**/*.ts`）与限定子目录叠加时，仍按工作区相对路径匹配，
    // 保证「pattern 的写法」与「结果里的路径」是同一坐标系（否则模型会拿到无法直接使用的相对路径）。
    const walk = await new WorkspaceFileWalker(root, {
      ...(this.walkMaxFiles === undefined ? {} : { maxFiles: this.walkMaxFiles }),
      ...(call.arguments['include_hidden'] === true ? { includeHidden: true } : {}),
    }).list();
    const matched = walk.files.filter(
      (file) => matcher.test(file) && (scope === '' || file.startsWith(`${scope}/`)),
    );
    // **截断 + 零命中 ⇒ 结果不可信，必须 fail-loud**（2026-10-06 真实 API 跑测实测）：
    // 遍历在 `third-party/`（近 2 万文件）撞满上限、根本没走到 `src/` 时，旧行为仍返回
    // `ok:true` + "（无命中）"，模型据此断定"文件不存在"并开始瞎试（实测浪费 16 步）。
    // 截断本身已在输出里标注，但"0 命中"这个结论必须降级为错误，否则仍是静默误导。
    if (walk.truncated && matched.length === 0) {
      return {
        callId: call.id,
        ok: false,
        error:
          `文件遍历在 ${String(walk.files.length)} 个文件处被上限截断，未走完整个工作区 ⇒ ` +
          '本次"0 命中"不可信。请用更具体的目录/模式缩小范围（例如先 list_dir 确认路径）。',
      };
    }
    return {
      callId: call.id,
      ok: true,
      output: GlobTool.render(matched, pattern, limit, walk.truncated),
    };
  }

  /**
   * 归一化子目录参数。
   *
   * @param root 生效的工作区根（用于解析相对路径）。
   * @param raw 原始子目录（可为空 / `.`）。
   * @returns 归一后的相对子目录（空串表示全工作区）；路径不存在或非目录时为 undefined。
   */
  private static async normalizeSubdir(root: string, raw: string): Promise<string | undefined> {
    const trimmed = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (trimmed === '' || trimmed === '.') {
      return '';
    }
    try {
      const info = await stat(resolve(root, trimmed));
      return info.isDirectory() ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 渲染结果清单与统计脚注。
   *
   * @param matched 命中的相对路径（已排序）。
   * @param pattern 原始模式（回显便于归因）。
   * @param limit 生效上限。
   * @param walkTruncated 文件遍历是否被上限截断。
   * @returns 最终工具输出。
   */
  private static render(
    matched: readonly string[],
    pattern: string,
    limit: number,
    walkTruncated: boolean,
  ): string {
    const shown = matched.slice(0, limit);
    const notes = [
      `pattern=${pattern}`,
      `命中 ${matched.length} 个文件`,
      matched.length > limit ? `仅显示前 ${limit} 个` : '',
      walkTruncated ? '文件遍历被上限截断' : '',
    ].filter((note) => note !== '');
    const body = shown.length > 0 ? `${shown.join('\n')}\n` : '（无命中）\n';
    return `${body}[glob: ${notes.join('；')}]`;
  }

  /**
   * 钳制返回上限。
   *
   * @param raw `max_results` 参数（未知类型）。
   * @returns 生效上限。
   */
  private static clampMaxResults(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return GlobTool.DEFAULT_MAX_RESULTS;
    }
    return Math.min(Math.max(1, Math.floor(raw)), GlobTool.MAX_RESULTS_LIMIT);
  }
}
