import type { AskQuestion } from './askQuestion.js';
import type { AskAnswer } from './askAnswer.js';

/**
 * @beta
 * 用户回答端口：一切"向人提问"能力的统一插口。
 */
export interface UserResponder {
  readonly name: string;
  ask(questions: readonly AskQuestion[]): Promise<readonly AskAnswer[]>;
}
