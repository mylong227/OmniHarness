/**
 * 回合完成闸门的**装配工厂**（2026-09-26 审计 A1 收口）。
 *
 * 为什么单独成一处：闸门要按运行期事实在两种实现之间挑一个，而这段判断放进 `Agent.buildTurnRunner`
 * 会把该方法的函数体推过门禁上限。工厂只做**选择**，不做执行（执行在 `TurnEndCompletionGate`）。
 *
 * 两种来源与口径：
 *  1. **写时自验证已启用**（工具端口是 `SelfVerifyingToolPort`，暴露 `lastFailure`）⇒ 直接读它的
 *     已有结论：零额外开销，任何时机都可问（`kind: 'status'`）；
 *  2. **未启用写时自验证** ⇒ 回合末尾**现跑一次**验证命令（`kind: 'turn-end'`）。策略就地解析：
 *     显式 `selfVerify.enabled === false` 视为「验证我的代码」的**整体退出** ⇒ 不设闸门；
 *     其余情况（含 `selfVerify` 未配置）只要工作区能探测出测试命令就设闸门。
 *
 * 于是「没开自验证的运行」不再等于「没有闸门」——这正是 A1 原先的缺口。
 *
 * 接线：本类实现端口 `ports/runtime/completionGate.ts` 的 `CompletionGateFactory`，由**组合根**
 * （`composition/runtime.ts`）注入到运行时字段 `runtime.completionGateFactory`；core 只调用端口、
 * 不 import 本模块（否则一次接线就会同时踩出 core→adapters 与 adapters→core 两条违规）。
 */

import type {
  CompletionGate,
  CompletionGateContext,
} from '../../../ports/runtime/completionGate.js';
import { SelfVerifyPolicy } from './selfVerifyPolicy.js';
import { TurnEndCompletionGate } from './turnEndCompletionGate.js';

/**
 * 完成闸门装配工厂（无状态），实现端口 {@link CompletionGateFactory}。
 * 依赖类型即端口契约 `CompletionGateContext`——core 传什么这里就收什么，不多取一位。
 */
export class TurnCompletionGateFactory {
  /**
   * 按运行期事实选出闸门实现。
   * @param deps 工具端口、自验证声明与工作区根（端口契约，见 `ports/runtime/completionGate.ts`）。
   * @returns 闸门；显式退出、或探测不到测试命令时为 undefined（不设闸门）。
   */
  public static of(deps: CompletionGateContext): CompletionGate | undefined {
    const candidate = deps.tools as unknown as {
      lastFailure?: (sessionId: string) => string | undefined;
    };
    if (typeof candidate.lastFailure === 'function') {
      return {
        kind: 'status',
        verify: async (sessionId: string): Promise<string | undefined> =>
          candidate.lastFailure?.(sessionId),
      };
    }
    const cfg = deps.selfVerify;
    if (cfg?.enabled === false) {
      return undefined;
    }
    const policy = SelfVerifyPolicy.forWorkspace(deps.workspaceRoot, {
      ...(cfg?.command !== undefined ? { command: cfg.command } : {}),
      ...(cfg?.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
      ...(cfg?.maxOutputBytes !== undefined ? { maxOutputBytes: cfg.maxOutputBytes } : {}),
      ...(cfg?.maxDigestLines !== undefined ? { maxDigestLines: cfg.maxDigestLines } : {}),
    });
    if (policy === undefined) {
      return undefined;
    }
    const gate = new TurnEndCompletionGate({ policy, workspaceRoot: deps.workspaceRoot });
    return { kind: 'turn-end', verify: (sessionId: string) => gate.verify(sessionId) };
  }
}
