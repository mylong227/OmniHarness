import type { AppendOnlyEventLog } from './appendOnlyEventLog.ts';
import type { SessionRecorder } from './sessionRecorder.ts';
import { ResumeGuidance } from './resumeGuidance.ts';
import { InterruptedToolCalls } from './interruptedToolCalls.ts';
import { TaskComplexityClassifier } from './planning/taskComplexityClassifier.ts';
import { ReasoningBudget, type ReasoningEffort } from '../util/reasoningBudget.ts';
import type { ImageContent, FileAttachment } from '../ports/model/model.ts';

/** 回合开场依赖（Agent 的私有能力以回调注入，避免把 Agent 推过行数/方法数上限）。 */
export interface AgentTurnSetupDeps {
  /** 打开/初始化会话。 */
  openSession(
    recorder: SessionRecorder,
    eventLog: AppendOnlyEventLog,
    prompt: string,
    sessionId: string,
    mode: 'run' | 'resume' | 'fork',
  ): void;
  /** 复杂任务强制规划指令。 */
  requirePlanning(prompt: string, recorder: SessionRecorder): void;
}

/** 回合开场输入。 */
export interface AgentTurnInput {
  readonly mode: 'run' | 'resume' | 'fork';
  readonly prompt: string;
  readonly sessionId: string;
  readonly eventLog: AppendOnlyEventLog;
  readonly recorder: SessionRecorder;
  readonly images?: readonly ImageContent[] | undefined;
  readonly files?: readonly FileAttachment[] | undefined;
}

/**
 * 回合开场（2026-10-23 从 `Agent.continueSession` 抽出：继续压低主流程函数体）。
 *
 * 顺序不可换：openSession（技能/记忆注入）→ 崩溃对账 → 续跑引导 → 规划指令 → user 事件。
 */
export class AgentTurnSetup {
  /**
   * 执行开场并返回生效的用户提示。
   * @param deps Agent 的私有能力。
   * @param input 开场输入。
   * @returns 生效的用户提示（resume 空提示时为续跑引导）。
   */
  public static beginTurn(deps: AgentTurnSetupDeps, input: AgentTurnInput): string {
    deps.openSession(input.recorder, input.eventLog, input.prompt, input.sessionId, input.mode);
    // 崩溃对账：悬空 tool_call 补「状态未知」结果，避免模型当成从未执行而重跑。
    if (input.mode !== 'run') {
      InterruptedToolCalls.recordInto(input.recorder, input.eventLog.all());
    }
    const effective =
      input.mode === 'resume' && input.prompt.trim() === ''
        ? ResumeGuidance.build(input.eventLog.all())
        : input.prompt;
    deps.requirePlanning(effective, input.recorder);
    input.recorder.user(effective, input.images, input.files);
    return effective;
  }

  /**
   * 本轮 executor 的推理强度：复杂度分层 + 用户显式配置优先。
   * @param configured 用户配置的推理档位。
   * @param prompt 本轮用户提示。
   * @returns 推理强度；`undefined` 表示不下发。
   */
  public static executorReasoningEffort(
    configured: ReasoningEffort | undefined,
    prompt: string,
  ): ReasoningEffort | undefined {
    return ReasoningBudget.executor(configured, TaskComplexityClassifier.assess(prompt).complex);
  }
}
