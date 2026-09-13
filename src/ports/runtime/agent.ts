import type { SessionEvent } from './event.js';
import type { FileAttachment, ImageContent } from '../model/model.js';
import type { OmniHarnessRuntime } from '../../core/runtime.js';

// 透出运行时类型，供组合根/测试从统一入口取得（避免各自 import core/runtime）。
export type { OmniHarnessRuntime };

/** Agent 单次任务的运行结果。 */
export interface AgentResult {
  /** 会话 ID（跨迭代/续跑复用同一会话）。 */
  readonly sessionId: string;
  /** 末轮模型产出文本。 */
  readonly finalText?: string | undefined;
  /** 执行的步数。 */
  readonly steps: number;
  /** 本次会话产生的全部事件（含工具调用、模型消息等）。 */
  readonly events: readonly SessionEvent[];
}

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

/**
 * Agent 工厂端口：组合根（config/）注入，按运行时构造 {@link AgentPort} 实例。
 * 解耦 adapters→core——run_goal 工具经本端口取得 Agent，不直接 new core 具体实现。
 */
export interface AgentFactoryPort {
  /**
   * 构造一个 Agent 实例。
   * @param runtime 子智能体运行时。
   * @returns Agent 端口实现。
   */
  create(runtime: OmniHarnessRuntime): AgentPort;
}
