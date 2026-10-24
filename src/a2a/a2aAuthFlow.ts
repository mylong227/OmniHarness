/**
 * A2A 1.0 任务内认证（`auth_required`）的状态迁移与提示构造（规范 §7.6）。
 *
 * 为什么单独成类：这段逻辑是「状态机 + 面向人的提示 + 结构化 challenge」的组合，
 * 与 JSON-RPC 方法分发（`A2aV1Methods`）不是同一职责。抽出来之后：
 * - 认证请求只有一个构造点，`status.message.metadata` 与任务级 `metadata` 不可能漂移；
 * - `A2aV1Methods` 不再因为认证判据变胖而越过体量门禁；
 * - 判据（tests/unit/a2aAuthRequired.test.ts）可以直接对着这一个类断言。
 */
import { log } from '../util/logger.ts';
import type { A2aAuthChallenge, A2aMessage, A2aTask } from './a2aProtocol.ts';
import type { A2aTaskStore } from './a2aTaskStore.ts';

/**
 * 任务内认证迁移器。
 */
export class A2aAuthFlow {
  /**
   * 把任务落到 `auth_required`：状态消息与任务元数据同时带 challenge。
   *
   * 规范 §7.6.1-3 要求「MUST 在 TaskStatus 消息里说明需要什么授权」——所以 `status.message`
   * 不是可选装饰，而是协议义务；`metadata.authChallenge` 是给程序读的结构化版本。
   * @param tasks 任务表。
   * @param task 任务快照。
   * @param challenge 执行器给出的认证请求。
   * @returns 更新后的任务（非终态，流式订阅不收尾）。
   */
  public static require(tasks: A2aTaskStore, task: A2aTask, challenge: A2aAuthChallenge): A2aTask {
    log.warn('a2a.task.auth.required', { taskId: task.id, scheme: challenge.scheme });
    return tasks.update(task.id, {
      state: 'auth_required',
      message: A2aAuthFlow.messageOf(task, challenge),
      metadata: { authChallenge: challenge },
    });
  }

  /**
   * 构造带 challenge 的状态消息。
   * @param task 任务快照（取上下文 id）。
   * @param challenge 认证请求。
   * @returns Agent 角色消息（metadata 里带结构化 challenge）。
   */
  private static messageOf(task: A2aTask, challenge: A2aAuthChallenge): A2aMessage {
    return {
      messageId: `${task.id}-auth`,
      role: 'agent',
      parts: [{ type: 'text', text: A2aAuthFlow.textOf(challenge) }],
      metadata: { authChallenge: challenge },
      ...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
    };
  }

  /**
   * 构造面向人的认证提示文本（`status.message.parts[0].text`）。
   * @param challenge 认证请求。
   * @returns 提示文本。
   */
  private static textOf(challenge: A2aAuthChallenge): string {
    const scopes =
      challenge.scopes !== undefined && challenge.scopes.length > 0
        ? `，scope: ${challenge.scopes.join(' ')}`
        : '';
    const url = challenge.url !== undefined ? `，获取方式: ${challenge.url}` : '';
    const description = challenge.description !== undefined ? `：${challenge.description}` : '';
    return `需要认证（${challenge.scheme}${scopes}${url}）${description}`;
  }
}
