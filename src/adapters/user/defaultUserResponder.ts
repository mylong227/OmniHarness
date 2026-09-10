import type { AskAnswer, AskQuestion, UserResponder } from '../../ports/userResponder.js';

/**
 * 无人值守/非交互式默认回答器（fail-soft）。
 *
 * 当前运行环境非 TTY 或无人值守时，无法真的向人提问。返回空选择 + 说明，
 * 让模型感知"未拿到真实回答"并自行分支，而不是让循环挂死。
 * 需要真实交互的前端应注入 {@link ConsoleUserResponder} 或自定义实现。
 */
export class DefaultUserResponder implements UserResponder {
  public readonly name = 'default';

  public async ask(questions: readonly AskQuestion[]): Promise<readonly AskAnswer[]> {
    const note = '(未配置交互式用户回答：当前运行环境非交互式/无人值守)';
    return questions.map((q) => ({ id: q.id, selected: [], custom: note }));
  }
}
