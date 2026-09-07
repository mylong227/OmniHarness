import type { AskAnswer, AskQuestion, UserResponder } from '../../ports/userResponder.js';

/** 测试/依赖注入用：按问题 id 预置答案，缺失则回空选择。 */
export class MemoryUserResponder implements UserResponder {
  readonly name = 'memory';

  constructor(private readonly answers: ReadonlyMap<string, AskAnswer> = new Map()) {}

  async ask(questions: readonly AskQuestion[]): Promise<readonly AskAnswer[]> {
    return questions.map((q) => this.answers.get(q.id) ?? { id: q.id, selected: [] });
  }
}
