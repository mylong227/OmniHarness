import type { FileAttachment, ImageContent } from '../../model/model.js';
import type { AgentResult } from './agentResult.js';
import type { SessionEvent } from '../event.js';

/**
 * Agent 主循环端口：建会话 → 记录输入 → 跑回合 → 持久化，对外暴露任务执行能力。
 * 由 {@link Agent}（core）实现；adapters / autonomy 仅依赖本端口，不感知 core 具体实现，
 * 从而切断 adapters→core 的反向依赖（P1 分层解耦）。
 */
export interface AgentPort {
  /**
   * 执行一次任务（新会话）。
   * @param prompt 用户输入。
   * @param images 可选：随首条用户消息送入模型的图片。
   * @param files 可选：随首条用户消息送入模型的文件。
   * @returns 任务运行结果。
   */
  runTask(
    prompt: string,
    images?: readonly ImageContent[],
    files?: readonly FileAttachment[],
  ): Promise<AgentResult>;

  /**
   * 续跑历史会话：加载原会话历史事件后继续（同一 sessionId）。
   * @param sessionId 目标会话 ID。
   * @param prompt 续跑提示。
   * @param images 可选图片。
   * @param files 可选文件。
   * @returns 任务运行结果。
   */
  resume(
    sessionId: string,
    prompt: string,
    images?: readonly ImageContent[],
    files?: readonly FileAttachment[],
  ): Promise<AgentResult>;

  /**
   * 分叉会话：复制历史事件到新 sessionId，独立演进不影响原会话。
   * @param sourceSessionId 源会话 ID。
   * @param prompt 推进提示。
   * @param images 可选图片。
   * @param files 可选文件。
   * @returns 任务运行结果。
   */
  fork(
    sourceSessionId: string,
    prompt: string,
    images?: readonly ImageContent[],
    files?: readonly FileAttachment[],
  ): Promise<AgentResult>;

  /**
   * 回放会话：加载并广播全部历史事件。
   * @param sessionId 目标会话 ID。
   * @returns 全部历史事件。
   */
  replay(sessionId: string): Promise<readonly SessionEvent[]>;
}
