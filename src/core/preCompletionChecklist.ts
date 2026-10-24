/**
 * 收尾检查清单（PreCompletionChecklist，2026-10-24）。
 *
 * 解决的问题：模型可以在**没有跑过任务验证命令**的情况下直接输出结论 —— 现有完成闸门
 * （`TurnEndCompletionGate`）只在「本回合改过文件」且工作区探测得到测试命令时才会现跑一次；
 * 长时程任务明明在 `features.json` 里声明了 `verifyCommand`，这条声明却没有任何执行点。
 *
 * 本类实现 `CompletionGate` 端口，作为**已有闸门外层**接入（`TurnRunner` 只认识端口）：
 *  1. 写时自验证（`SelfVerifyingToolPort.lastFailure`）已有失败摘要 ⇒ 原样回灌（与既有闸门口径一致）；
 *  2. 否则先问内层闸门；内层有结论就沿用（不重复跑两套验证）；
 *  3. 否则读任务状态：配置了 `verifyCommand` 且**未通过** ⇒ 注入一次「先验证再结束」提示。
 *
 * 有界性：`used` 标记保证同一实例最多注入一次；`TurnRunner` 本身也保证每回合至多问一次闸门
 * （第二次宣告完成直接放行并如实记 `unverified`）——两道保险共同防「验证-重试」死循环。
 *
 * 失败取向：命令**跑不起来**（工具链缺失 / spawn 失败）一律 fail-open，不阻断收尾；命令跑了但
 * 退出码非 0 / 超时 ⇒ 视为未通过并注入一次提示（这正是本类要拦截的「过早宣布完成」）。
 */

import type { CompletionGate } from '../ports/runtime/completionGate.ts';
import type { LongHorizonProtocol } from '../context/longHorizonProtocol.ts';

/** 构造依赖。 */
export interface PreCompletionChecklistDeps {
  /** 长时程任务状态（提供 `verifyCommand` 与验证执行）。 */
  readonly protocol: LongHorizonProtocol;
  /** 已有完成闸门（可选）：本类只做「补一道」，不替换既有判定。 */
  readonly inner?: CompletionGate | undefined;
  /** 写时自验证的最近失败读取器（对齐 `SelfVerifyingToolPort.lastFailure`；可缺省）。 */
  readonly lastFailure?: ((sessionId: string) => string | undefined) | undefined;
}

/** 回灌文本里保留的输出上限（字符数）：只要可定位失败，不要把 64KB 日志灌进上下文。 */
const MAX_DIGEST_CHARS = 2_000;

/**
 * 收尾检查清单闸门。
 */
export class PreCompletionChecklist implements CompletionGate {
  /** 闸门种类：有内层闸门时沿用其触发条件；独立存在时按 `status` 处理（任何宣告都问一次）。 */
  public readonly kind: 'status' | 'turn-end';
  /** 是否已经注入过一次（有界性：防死循环）。 */
  private used = false;
  /** 构造依赖。 */
  private readonly deps: PreCompletionChecklistDeps;

  /**
   * @param deps 任务状态、可选内层闸门与写时自验证失败读取器。
   */
  public constructor(deps: PreCompletionChecklistDeps) {
    this.deps = deps;
    this.kind = deps.inner?.kind ?? 'status';
  }

  /**
   * 模型准备结束时核验一次。
   * @param sessionId 会话 id（透传给内层闸门与写时自验证读取器）。
   * @returns 需要回灌的提示文本；通过 / 无法验证 / 已用过时为 undefined。
   */
  public async verify(sessionId: string): Promise<string | undefined> {
    if (this.used) {
      return undefined;
    }
    const lastFailure = this.deps.lastFailure?.(sessionId);
    if (lastFailure !== undefined && lastFailure.trim() !== '') {
      this.used = true;
      return [
        '【收尾检查清单】写时自验证最近一次**未通过**，先修好再收尾：',
        PreCompletionChecklist.digest(lastFailure),
        '若你判断该失败与本回合改动无关（环境缺失/既有失败），请在结论里逐条说明依据。',
      ].join('\n');
    }
    const inner = await this.deps.inner?.verify(sessionId);
    if (inner !== undefined && inner.trim() !== '') {
      this.used = true;
      return inner;
    }
    const state = this.deps.protocol.read();
    if (state.verifyCommand === undefined) {
      return undefined;
    }
    const result = await this.deps.protocol.verify();
    if (!result.ran) {
      // fail-open：命令根本跑不起来（工具链缺失）不是「改动坏了」，不该把回合卡死。
      return undefined;
    }
    if (result.ok) {
      return undefined;
    }
    this.used = true;
    const reason = result.timedOut
      ? '验证命令超时'
      : `验证未通过（exit=${String(result.exitCode ?? 'null')}）`;
    return [
      `【收尾检查清单】${reason}：${state.verifyCommand}`,
      '你已准备结束，但任务声明的验证命令没有通过。请先运行下面的命令、修到通过，再宣告完成；',
      '若你判断失败与本次改动无关，请在结论里明确写出是哪一条、依据是什么。',
      '验证输出（尾部）：',
      PreCompletionChecklist.digest(result.output),
    ].join('\n');
  }

  /**
   * 把验证输出压成可回灌的摘要（保留尾部，去掉首尾空白）。
   * @param text 原始输出。
   * @returns 截断后的文本；空输出返回 `（无输出）`。
   */
  private static digest(text: string): string {
    const trimmed = text.trim();
    if (trimmed === '') return '（无输出）';
    return trimmed.length > MAX_DIGEST_CHARS
      ? `…${trimmed.slice(trimmed.length - MAX_DIGEST_CHARS)}`
      : trimmed;
  }
}
