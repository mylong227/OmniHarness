/**
 * 任务复杂度分类（2026-10-22）。
 *
 * 目的：把「多步任务先规划」从纯提示词建议提升为**回合级强制指令**——复杂任务在用户消息
 * 之前注入一条系统规划要求，模型第一步就被要求写 todo。分类必须保守：宁可漏判（退回提示词
 * 的软约束），也不要把一句简单问题误判成复杂任务。
 *
 * 所有阈值可经环境变量覆盖；默认值集中在本类，避免散落在调用点。
 */
export interface TaskComplexity {
  /** 是否判定为复杂多步任务。 */
  readonly complex: boolean;
  /** 命中的信号数（诊断用）。 */
  readonly score: number;
  /** 人类可读的判定理由。 */
  readonly reasons: readonly string[];
}

/** 分类阈值。 */
export interface TaskComplexityOptions {
  /** 长文本阈值（字符数）。 */
  readonly minChars?: number;
  /** 至少命中的动作词数量。 */
  readonly minActionSignals?: number;
}

/** 分类器。 */
export class TaskComplexityClassifier {
  /** 缺省长文本阈值。 */
  private static readonly DEFAULT_MIN_CHARS = 240;
  /** 缺省动作词阈值。 */
  private static readonly DEFAULT_MIN_ACTION_SIGNALS = 1;
  /** 动作词（中英混合；只用于判断"这是一件要做的事"，不是语义理解）。 */
  private static readonly ACTION_WORDS =
    /(实现|修改|修复|重构|添加|删除|测试|编写|改造|接入|完善|优化|排查|implement|fix|refactor|add|remove|test|build|update|migrate)/giu;
  /** 顺序词（出现两个以上说明任务有阶段）。 */
  private static readonly SEQUENCE_WORDS =
    /(先|然后|接着|之后|最后|再|first|then|next|after|finally)/giu;
  /** 文件路径（按不同路径数判断多文件；只匹配扩展名会漏掉同后缀多文件）。 */
  private static readonly FILE_PATTERN =
    /[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|json|css|scss|py|rs|go|java|kt|sql|yml|yaml)\b/giu;

  /**
   * 评估任务文本。
   * @param prompt 用户本轮任务。
   * @param options 阈值覆盖。
   * @returns 复杂度结论。
   */
  public static assess(prompt: string, options: TaskComplexityOptions = {}): TaskComplexity {
    const text = prompt.trim();
    if (text === '') {
      return { complex: false, score: 0, reasons: [] };
    }
    const minChars = TaskComplexityClassifier.envInt(
      'OMNI_PLANNING_MIN_CHARS',
      options.minChars ?? TaskComplexityClassifier.DEFAULT_MIN_CHARS,
    );
    const minActions = TaskComplexityClassifier.envInt(
      'OMNI_PLANNING_MIN_ACTIONS',
      options.minActionSignals ?? TaskComplexityClassifier.DEFAULT_MIN_ACTION_SIGNALS,
    );
    const actions = TaskComplexityClassifier.count(text, TaskComplexityClassifier.ACTION_WORDS);
    const sequences = TaskComplexityClassifier.count(text, TaskComplexityClassifier.SEQUENCE_WORDS);
    const files = new Set(
      [...text.matchAll(TaskComplexityClassifier.FILE_PATTERN)].map((match) =>
        match[0].toLowerCase(),
      ),
    ).size;
    const bullets = text
      .split(/\r?\n/u)
      .filter((line) => /^\s*(?:\d+[.)]|[-*])\s+/u.test(line)).length;
    const reasons: string[] = [];
    let score = 0;
    if (text.length >= minChars && actions >= minActions) {
      score += 1;
      reasons.push(`长任务文本（${String(text.length)} 字符）`);
    }
    if (files >= 2 && actions >= minActions) {
      score += 1;
      reasons.push(`涉及多个文件（${String(files)} 个路径）`);
    }
    if (sequences >= 2 && actions >= minActions) {
      score += 1;
      reasons.push(`含多阶段顺序词（${String(sequences)} 个）`);
    }
    if (bullets >= 3) {
      score += 1;
      reasons.push(`用户列了 ${String(bullets)} 条步骤`);
    }
    return { complex: score >= 1, score, reasons };
  }

  /**
   * 读取整数环境变量（非法/非正数回退默认）。
   * @param name 环境变量名。
   * @param fallback 默认值。
   * @returns 阈值。
   */
  private static envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }

  /**
   * 统计正则命中次数（global 正则每次重置 lastIndex）。
   * @param text 文本。
   * @param pattern 正则。
   * @returns 命中次数。
   */
  private static count(text: string, pattern: RegExp): number {
    pattern.lastIndex = 0;
    return [...text.matchAll(pattern)].length;
  }
}

/** 规划要求系统消息（回合级强制指令）。 */
export class PlanningDirective {
  /**
   * 构造规划要求文本。
   * @param complexity 分类结论。
   * @returns 系统消息正文。
   */
  public static text(complexity: TaskComplexity): string {
    const why = complexity.reasons.length === 0 ? '多步任务' : complexity.reasons.join('；');
    return (
      `【规划要求】本任务被判定为复杂任务（${why}）。第一步必须调用 \`todo_write\` 写 2–6 条` +
      '可执行步骤（动作 + 验证方式），再开始改文件或跑长命令；执行中保持一条 in_progress，' +
      '完成一项立即更新。不要跳过规划直接动手。'
    );
  }

  /**
   * 是否启用回合级规划强制（`OMNI_PLANNING_GUARD=0` 可关闭，供测试/特殊部署）。
   * @returns 启用时为 true。
   */
  public static enabled(): boolean {
    return process.env['OMNI_PLANNING_GUARD'] !== '0';
  }
}
