/**
 * 用户回答端口（对标 DeepSeek `packages/interaction/tool-ask-user`）。
 *
 * 模型面工具 `ask_user` 经此端口暂停并等待真人/前端回答案，再作为普通工具结果
 * 喂回 agent 循环。端口实现可替换：TTY 交互、RPC 等待队列、测试注入等。
 *
 * 本文件已退化为桶：4 个接口各自独立成文件于 `./userResponder/`，调用点零改动。
 */

export type { AskOption } from './userResponder/askOption.js';
export type { AskQuestion } from './userResponder/askQuestion.js';
export type { AskAnswer } from './userResponder/askAnswer.js';
export type { UserResponder } from './userResponder/userResponder.js';
