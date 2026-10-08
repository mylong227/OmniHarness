import type { AskAnswer, AskQuestion } from '../../ports/runtime/userResponder.js';

/** 单题自由输入上限（字符）：上行通道是外部输入，超长文本不进模型上下文。 */
const MAX_CUSTOM_CHARS = 4000;

/** 答案解析结果：成功给同序答案；失败给一句可读拒因（**不静默兜底**）。 */
export type ParsedQuestionAnswers =
  | { readonly ok: true; readonly answers: readonly AskAnswer[] }
  | { readonly ok: false; readonly error: string };

/**
 * 提问上行的答案校验器（`question.respond` 的唯一入口）。
 *
 * 为什么要单独校验而不是原样透传：`answers` 来自客户端，最终会作为**工具结果原文**喂回模型
 * （`ask_user` 的输出就是它的 JSON）。原样透传等于让任何能发 RPC 的一方直接往模型上下文里
 * 注入任意文本与"已选标签"——本仓的注入护栏家族（promptInjectionGuard / 工具输出信任）
 * 正是防这一类。故此处只接受「与本次提问严格同构」的答案：
 *   - 题 id 必须属于本次提问，禁止新增/重复/未知题；
 *   - `selected` 只接受该题**确实提供过**的选项标签（没给选项的题只能走 `custom`）；
 *   - `custom` 限长；未作答的题按空选择回填，保证答案数组与提问同序同长。
 */
export class QuestionAnswers {
  /**
   * 解析客户端答案。
   * @param raw 客户端提交的 `answers`（未知类型，逐项校验）。
   * @param questions 本次提问（校验的唯一基准）。
   * @returns 同序答案，或一句拒因。
   */
  public static parse(raw: unknown, questions: readonly AskQuestion[]): ParsedQuestionAnswers {
    if (!Array.isArray(raw)) {
      return { ok: false, error: 'answers 必须是数组' };
    }
    const byId = new Map<string, { selected: string[]; custom: string }>();
    for (const item of raw) {
      const invalid = QuestionAnswers.readItem(item, questions, byId);
      if (invalid !== undefined) {
        return { ok: false, error: invalid };
      }
    }
    return { ok: true, answers: QuestionAnswers.ordered(questions, byId) };
  }

  /**
   * 读入一条答案：校验形状、题目归属与选项合法性，验过写入 `byId`。
   * @param item 客户端答案条目（未知类型）。
   * @param questions 本次提问。
   * @param byId 累积表（题目 id → 选择与自由输入）。
   * @returns 通过时 undefined；否则一句拒因。
   */
  private static readItem(
    item: unknown,
    questions: readonly AskQuestion[],
    byId: Map<string, { selected: string[]; custom: string }>,
  ): string | undefined {
    if (typeof item !== 'object' || item === null) {
      return 'answers 的每一项必须是对象';
    }
    const record = item as Record<string, unknown>;
    const id = record['id'];
    if (typeof id !== 'string' || id === '') {
      return 'answers 的每一项必须有非空 id';
    }
    const question = questions.find((candidate) => candidate.id === id);
    if (question === undefined) {
      return `答案引用了本次提问之外的题目 id：${id}`;
    }
    if (byId.has(id)) {
      return `同一题目 id 重复作答：${id}`;
    }
    const selected = record['selected'] ?? [];
    if (!Array.isArray(selected) || selected.some((label) => typeof label !== 'string')) {
      return `题目 ${id} 的 selected 必须是字符串数组`;
    }
    const labels = question.options?.map((option) => option.label) ?? [];
    const unknown = (selected as string[]).find((label) => !labels.includes(label));
    if (unknown !== undefined) {
      return `题目 ${id} 选择了未提供的选项：${unknown}`;
    }
    if (question.multiSelect !== true && selected.length > 1) {
      return `题目 ${id} 是单选题，只接受一个选项`;
    }
    const custom = record['custom'];
    if (custom !== undefined && typeof custom !== 'string') {
      return `题目 ${id} 的 custom 必须是字符串`;
    }
    if (typeof custom === 'string' && custom.length > MAX_CUSTOM_CHARS) {
      return `题目 ${id} 的 custom 超过 ${String(MAX_CUSTOM_CHARS)} 字符上限`;
    }
    byId.set(id, {
      selected: [...(selected as string[])],
      custom: typeof custom === 'string' ? custom : '',
    });
    return undefined;
  }

  /**
   * 按提问顺序回填答案（未作答的题以空选择 + 空自由输入占位），保证同序同长。
   * @param questions 本次提问。
   * @param byId 已校验的答案表。
   * @returns 同序答案数组。
   */
  private static ordered(
    questions: readonly AskQuestion[],
    byId: Map<string, { selected: string[]; custom: string }>,
  ): readonly AskAnswer[] {
    return questions.map((question) => {
      const answer = byId.get(question.id);
      if (answer === undefined) {
        return { id: question.id, selected: [] as string[], custom: '' };
      }
      return { id: question.id, selected: answer.selected, custom: answer.custom };
    });
  }
}
