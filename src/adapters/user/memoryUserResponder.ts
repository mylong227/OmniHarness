import type { AskAnswer, AskQuestion, UserResponder } from '../../ports/userResponder.js';

/** 测试/依赖注入用：按问题 id 预置答案，缺失则回空选择。 */
export class MemoryUserResponder implements UserResponder {
  /**
   * 回答器标识：固定为 'memory'，用于区分测试/依赖注入用的预置答案实现。
   */
  public readonly name = 'memory';

  public constructor(private readonly answers: ReadonlyMap<string, AskAnswer> = new Map()) {}

  /**
   * 按问题 id 从预置答案表取回答，缺失则用空选择兜底。
   * @param questions 待回答的问题列表。
   * @returns 与 questions 同序：命中预置答案者原样返回，否则返回 id 相同、selected 为空的占位。
   */
  public async ask(questions: readonly AskQuestion[]): Promise<readonly AskAnswer[]> {
    return questions.map((q) => this.answers.get(q.id) ?? { id: q.id, selected: [] });
  }
}
