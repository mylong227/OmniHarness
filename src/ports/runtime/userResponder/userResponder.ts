import type { AskQuestion } from './askQuestion.js';
import type { AskAnswer } from './askAnswer.js';
import type { AskContext } from './askContext.js';

/**
 * @beta
 * 用户回答端口：一切"向人提问"能力的统一插口。
 */
export interface UserResponder {
  readonly name: string;
  /**
   * 向用户提问并等待回答。
   * @param questions 待回答的问题列表（单选/多选/开放）。
   * @param context 提问上下文（会话 id 等；可缺省，缺省即「无归属」）。
   * @returns 与 questions 同序的回答数组。
   */
  ask(questions: readonly AskQuestion[], context?: AskContext): Promise<readonly AskAnswer[]>;
}
