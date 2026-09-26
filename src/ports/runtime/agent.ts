import type { SessionEvent } from './event.js';
import type { FileAttachment, ImageContent } from '../model/model.js';

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
  /**
   * 是否因**步数耗尽**而收尾（未自然收敛）。
   *
   * 存在理由（2026-09-26 审计 F10）：原先调用方无法区分「任务完成」与「跑满步数被截断」——
   * 子代理被截断时仍以 `ok:true` 上报父级，父级只看到一句兜底摘要，据此认为子任务已完成。
   * 缺省 undefined ＝ 未上报（保持既有实现与测试的兼容）。
   */
  readonly truncated?: boolean | undefined;
  /** 是否因**失控熔断 / 取消**而中断（与 truncated 同属「没做完」）。 */
  readonly aborted?: boolean | undefined;
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
 *
 * **为什么运行时是类型参数**（2026-09-22 修，审计 P1-4）：本端口此前直接 import 了
 * `OmniHarnessRuntime`（来自 core 的运行时实现模块），把端口契约绑死在一个**具体实现类型**上——
 * 「ports 只依赖契约」在类型层被破坏，且架构门禁看不见（它原先只判 core↔adapters）。
 * 改为泛型参数后，端口自身只声明「存在某个运行时形状」，由实现方（`config/agentFactory.ts`）
 * 绑定具体类型；消费方（`runGoalTool`）用缺省参数即可。
 * 类型参数缺省 `unknown`：方法参数位置是双变的（strictFunctionTypes 下方法签名仍双变），
 * 故「接受具体运行时的实现」可安全赋给「接受 unknown 的端口」，无需任何类型逃逸。
 * @typeParam TRuntime 运行时形状（实现方绑定具体类型；消费方缺省 unknown）
 */
export interface AgentFactoryPort<TRuntime = unknown> {
  /**
   * 构造一个 Agent 实例。
   * @param runtime 子智能体运行时。
   * @returns Agent 端口实现。
   */
  create(runtime: TRuntime): AgentPort;
}
