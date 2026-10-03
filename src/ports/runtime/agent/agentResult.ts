import type { SessionEvent } from '../event.js';
import type { VerificationState } from '../completionGate/verificationState.js';

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
  /**
   * 本回合的**验证状态**（G3-V2，2026-10-03）：`not-run` / `failed` / `unverified`。
   *
   * 存在理由：完成闸门每回合至多跑一次，模型二次宣告完成会被放行；若不给这个字段，
   * 上层只能把"放行"读成"验证通过"。**`'unverified'` 不得读成通过**——它表示本回合以
   * "未核验通过"收尾（语义见 `ports/runtime/completionGate/verificationState.ts`）。
   */
  readonly verificationState?: VerificationState | undefined;
}
