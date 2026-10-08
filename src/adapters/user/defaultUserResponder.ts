import type { AskAnswer, AskQuestion, UserResponder } from '../../ports/runtime/userResponder.js';

/**
 * 无人值守/非交互式默认回答器（fail-soft）。
 *
 * 当前运行环境非 TTY 或无人值守时，无法真的向人提问。返回空选择 + 说明，
 * 让模型感知"未拿到真实回答"并自行分支，而不是让循环挂死。
 * 需要真实交互的前端应注入 {@link ConsoleUserResponder} 或自定义实现。
 */
export class DefaultUserResponder implements UserResponder {
  /**
   * 回答器标识：固定为 'default'，用于区分无人值守/非交互式的默认实现。
   */
  public readonly name = 'default';

  /**
   * 无人值守占位回答（fail-soft）：不真正提问，逐题返回空选择 + 说明，让模型感知"未拿到真实回答"自行分支。
   * @param questions 待提问的问题列表。
   * @returns 与 questions 同序的回答，selected 恒为空、custom 为未配置交互式回答的说明文本。
   */
  public async ask(questions: readonly AskQuestion[]): Promise<readonly AskAnswer[]> {
    return DefaultUserResponder.answersFor(questions);
  }

  /**
   * 占位回答的**同步**形态：同一口径供「问答上行超时 / 客户端全部断开」等无法 await 的收尾路径复用。
   *
   * 为什么必须共用一个函数：上行超时兜底若另写一份文案，就会出现「同一种"没拿到回答"
   * 在两条路径上给模型的说明不一样」的漂移（本仓缺陷家族里的"一份口径两处实现"）。
   * @param questions 待提问的问题列表。
   * @returns 与 questions 同序的占位回答。
   */
  public static answersFor(questions: readonly AskQuestion[]): readonly AskAnswer[] {
    const note = '(未配置交互式用户回答：当前运行环境非交互式/无人值守)';
    return questions.map((q) => ({ id: q.id, selected: [], custom: note }));
  }
}
