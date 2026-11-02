/**
 * trace → patch 提案器（2026-10-22，P1-4 第二片）。
 *
 * 输入是失败信号（工具结果/测试命令/报错文本），输出是**可复核的补丁计划**：
 * 复现命令、涉及文件、最小修改假设、验证命令。它不改文件、不自动合并——
 * 「自动落补丁」必须另有验证闭环，不能把模型猜测直接写进工作区。
 */
export interface TraceSignal {
  /** 工具名（如 bash / edit / test）。 */
  readonly tool?: string | undefined;
  /** 工具是否成功；false 视为失败信号。 */
  readonly ok?: boolean | undefined;
  /** 工具输出/报错文本。 */
  readonly output?: string | undefined;
  /** 关联文件（若有）。 */
  readonly path?: string | undefined;
  /** 复现/验证命令（若有）。 */
  readonly command?: string | undefined;
}

/** 一条失败证据。 */
export interface TraceFailure {
  /** 工具名（缺省 unknown）。 */
  readonly tool: string;
  /** 截断后的证据（≤400 字符；不把整段日志塞进计划）。 */
  readonly excerpt: string;
}

/** 补丁计划中的一步。 */
export interface PatchStep {
  /** 稳定 id（reproduce/inspect/fix/verify）。 */
  readonly id: 'reproduce' | 'inspect' | 'fix' | 'verify';
  /** 标题。 */
  readonly title: string;
  /** 可执行细节。 */
  readonly detail: string;
}

/** 补丁计划（schemaVersion 固定 1）。 */
export interface TracePatchPlan {
  readonly schemaVersion: 1;
  readonly failures: readonly TraceFailure[];
  readonly files: readonly string[];
  readonly commands: readonly string[];
  readonly steps: readonly PatchStep[];
}

/**
 * 纯逻辑提案器（无 IO、确定性排序；同输入同输出）。
 */
export class TracePatchPlanner {
  /** 失败文本特征。 */
  private static readonly FAILURE_PATTERN =
    /(error|failed|failure|assertionerror|enoent|eacces|timed out|exit code [1-9]|TS\d{4})/iu;
  /**
   * 文件路径特征（绝对/相对，常见源码后缀；不匹配 URL）。
   * 负向后行断言排除紧邻 `/`/`:`/`.`/词字符的起点（URL 的 `://host/x.ts` 会被排除）；
   * 后缀最长优先（`tsx` 先于 `ts`，`json` 先于 `js`），避免 `.tsx` 被截成 `.ts`。
   */
  private static readonly FILE_PATTERN =
    /(?<![\w./:-])(?:[A-Za-z]:)?[\\/]?(?:[\w.@-]+[\\/])+[\w.@-]+\.(?:tsx|ts|json|js|mjs|cjs|md|py|rs)(?![\w.])/gu;
  /** 单条证据上限。 */
  private static readonly MAX_EXCERPT = 400;

  /**
   * 生成计划。
   * @param signals 失败/成功信号。
   * @returns 确定性计划。
   */
  public static plan(signals: readonly TraceSignal[]): TracePatchPlan {
    const failures: TraceFailure[] = [];
    const files = new Set<string>();
    const commands = new Set<string>();
    for (const signal of signals) {
      if (signal.path !== undefined && signal.path !== '' && files.size < 100) {
        files.add(signal.path);
      }
      if (signal.command !== undefined && signal.command.trim() !== '') {
        commands.add(signal.command.trim());
      }
      const output = signal.output ?? '';
      const failed =
        signal.ok === false ||
        (signal.ok !== true && output !== '' && TracePatchPlanner.FAILURE_PATTERN.test(output));
      if (!failed) continue;
      failures.push({
        tool: signal.tool ?? 'unknown',
        excerpt: TracePatchPlanner.excerpt(output),
      });
      for (const match of output.matchAll(TracePatchPlanner.FILE_PATTERN)) {
        files.add(match[0]);
        if (files.size >= 100) break;
      }
    }
    const sortedFiles = [...files].sort();
    const sortedCommands = [...commands].sort();
    return {
      schemaVersion: 1,
      failures,
      files: sortedFiles,
      commands: sortedCommands,
      steps: TracePatchPlanner.steps(failures, sortedFiles, sortedCommands),
    };
  }

  /**
   * 渲染为 markdown（给人类看；机器读用 `plan` 的 JSON）。
   * @param plan 计划。
   * @returns markdown。
   */
  public static toMarkdown(plan: TracePatchPlan): string {
    const lines = ['# trace → patch 计划', ''];
    lines.push(`失败证据：${String(plan.failures.length)} 条`);
    for (const failure of plan.failures) {
      lines.push(`- [${failure.tool}] ${failure.excerpt.replace(/\n/gu, ' ')}`);
    }
    lines.push('', '涉及文件：');
    for (const file of plan.files) lines.push(`- \`${file}\``);
    if (plan.files.length === 0) lines.push('- （未从证据中识别到文件）');
    lines.push('', '步骤：');
    for (const step of plan.steps) lines.push(`- **${step.id}** ${step.title}：${step.detail}`);
    return lines.join('\n');
  }

  /**
   * 截断证据。
   * @param text 原始输出。
   * @returns 最多 400 字符 + 省略号。
   */
  private static excerpt(text: string): string {
    const compact = text.trim();
    return compact.length <= TracePatchPlanner.MAX_EXCERPT
      ? compact
      : `${compact.slice(0, TracePatchPlanner.MAX_EXCERPT)}…`;
  }

  /**
   * 构造确定性步骤。
   * @param failures 失败证据。
   * @param files 涉及文件（已排序）。
   * @param commands 复现/验证命令（已排序）。
   * @returns 四步计划。
   */
  private static steps(
    failures: readonly TraceFailure[],
    files: readonly string[],
    commands: readonly string[],
  ): readonly PatchStep[] {
    const reproduce = commands[0] ?? '从失败工具/测试重新跑同一命令';
    const inspect = files.length > 0 ? files.join('、') : '先用 grep/read 定位报错行';
    return [
      {
        id: 'reproduce',
        title: '复现',
        detail: `${reproduce}（先确认失败可稳定复现，再改代码）`,
      },
      {
        id: 'inspect',
        title: '定位',
        detail: `检查 ${inspect}；对照失败证据的最后一条调用栈/断言`,
      },
      {
        id: 'fix',
        title: '最小修改',
        detail:
          failures.length === 0
            ? '没有失败证据，不生成修改'
            : '只改与失败证据直接相关的文件；不顺手重构，不扩大 diff',
      },
      {
        id: 'verify',
        title: '验证',
        detail: commands[0] ?? '重跑失败命令 + 相关单测；无验证不合并',
      },
    ];
  }
}
