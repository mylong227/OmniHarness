/**
 * 长时程回合接线（2026-10-24）。
 *
 * 职责：把 {@link LongHorizonProtocol}（磁盘三件套）与真实回合生命周期连起来，且**不把历史塞回上下文**：
 *  - 开场（`begin`）：复杂任务或 `OMNI_LONG_HORIZON=1` 时 ensure 状态件，注入 4 行极简 primer；
 *  - 收尾（`finish`）：把本轮「用户提示 / 工具失败 / 验证是否通过」append 进 progress.md；
 *  - 完成闸门（`checklistFor`）：给 `TurnRunner` 套一层 {@link PreCompletionChecklist}。
 *
 * 开关（显式、可审计）：
 *  - `OMNI_LONG_HORIZON=1` 强制开；`=0` 强制关（复杂任务也不开）；
 *  - 未设置时按 `TaskComplexityClassifier.complex` 自动判定；
 *  - `OMNI_LONG_HORIZON_TASK` 显式任务 slug；`OMNI_LONG_HORIZON_VERIFY` 显式验证命令。
 *
 * 边界：本类只做「读状态 → 写一行进度」，不做压缩、不摘要历史；verify 失败只记录，不改变
 * 回合成功/失败判定（判定仍归 `TurnRunner` 的完成闸门与 `truncated` 语义）。
 */

import type { CompletionGate } from '../ports/runtime/completionGate.ts';
import type { SessionEvent } from '../ports/runtime/event.ts';
import type { SessionRecorder } from './sessionRecorder.ts';
import {
  LongHorizonProtocol,
  isValidSlug,
  seedFeaturesFromPrompt,
  slugFor,
  titleOfPrompt,
  type LongHorizonFeature,
} from '../context/longHorizonProtocol.ts';
import { PreCompletionChecklist } from './preCompletionChecklist.ts';
import { TaskComplexityClassifier } from './planning/taskComplexityClassifier.ts';

/** 协调器构造参数。 */
export interface LongHorizonCoordinatorOptions {
  /** 工作区根（状态件只能落在这里）。 */
  readonly workspaceRoot: string;
  /** 进程环境（缺省 `process.env`；测试可注入）。 */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** 可注入时钟（测试用；缺省 `Date.now`）。 */
  readonly now?: (() => number) | undefined;
}

/** 一轮长时程回合的内存记录（回合结束即释放）。 */
export interface LongHorizonTurnRecord {
  /** 本轮协议实例（完成闸门与收尾共用，保证 verify 结果复用）。 */
  readonly protocol: LongHorizonProtocol;
  /** 本轮的**原始用户提示**（不要用 `lastUserText`：它可能取到 nudge/检查清单）。 */
  readonly prompt: string;
  /** 回合开始时间戳（毫秒）。 */
  readonly startedAt: number;
}

/** 工具失败统计（progress.md 只写计数与少量名字，不写全部输出）。 */
export interface LongHorizonToolFailures {
  /** 本回合失败的工具结果条数。 */
  readonly count: number;
  /** 失败工具名（去重，按首次出现顺序；最多 8 个）。 */
  readonly names: readonly string[];
}

/** 失败工具名记录上限。 */
const MAX_FAILED_TOOL_NAMES = 8;

/**
 * 长时程回合协调器（每会话一份，进程内持有）。
 */
export class LongHorizonCoordinator {
  /** 工作区根。 */
  private readonly workspaceRoot: string;
  /** 生效环境。 */
  private readonly env: NodeJS.ProcessEnv;
  /** 可注入时钟。 */
  private readonly now: (() => number) | undefined;
  /** 会话 id → 本轮记录（回合结束删除，不跨回合持有状态）。 */
  private readonly records = new Map<string, LongHorizonTurnRecord>();

  /**
   * @param options 工作区、可选环境与时钟。
   */
  public constructor(options: LongHorizonCoordinatorOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.env = options.env ?? process.env;
    this.now = options.now;
  }

  /**
   * 判定长时程协议是否启用（显式开关优先，其次任务复杂度）。
   * @param prompt 本轮用户提示。
   * @param env 进程环境（缺省 `process.env`）。
   * @returns 启用为 true。
   */
  public static enabled(prompt: string, env: NodeJS.ProcessEnv = process.env): boolean {
    const flag = env['OMNI_LONG_HORIZON'];
    if (flag === '1') return true;
    if (flag === '0') return false;
    return TaskComplexityClassifier.assess(prompt).complex;
  }

  /**
   * 回合开场：ensure 状态件并注入极简 primer（已在本轮记录的会话直接复用）。
   * @param prompt 本轮生效的用户提示。
   * @param recorder 会话记录器（primer 写成 system 事件）。
   * @param sessionId 会话 id。
   * @returns 是否已启用并注入（未启用/状态件不可用时 false）。
   */
  public begin(prompt: string, recorder: SessionRecorder, sessionId: string): boolean {
    const existing = this.records.get(sessionId);
    if (existing === undefined && !LongHorizonCoordinator.enabled(prompt, this.env)) {
      return false;
    }
    const protocol = existing?.protocol ?? this.buildProtocol(prompt, sessionId);
    const ensured = existing === undefined ? protocol.ensure() : { ok: true };
    if (!ensured.ok) {
      return false;
    }
    const record: LongHorizonTurnRecord = {
      protocol,
      prompt: existing?.prompt ?? prompt,
      startedAt: existing?.startedAt ?? this.now?.() ?? Date.now(),
    };
    this.records.set(sessionId, record);
    const primer = protocol.renderPrimer();
    if (primer !== '') {
      recorder.system(primer);
    }
    return true;
  }

  /**
   * 回合收尾：把本轮用户提示 / 工具失败 / 验证结论追加到 progress.md（失败不抛）。
   * @param sessionId 会话 id。
   * @param recorder 会话记录器（提供本回合事件切片与验证状态）。
   * @returns 无返回值。
   */
  public async finish(sessionId: string, recorder: SessionRecorder): Promise<void> {
    const record = this.records.get(sessionId);
    this.records.delete(sessionId);
    if (record === undefined) {
      return;
    }
    try {
      const failures = LongHorizonCoordinator.toolFailuresOf(recorder.eventsSinceTurnStart());
      const state = record.protocol.read();
      const elapsedMs = Math.max(0, (this.now?.() ?? Date.now()) - record.startedAt);
      const note = `回合结束（耗时 ${String(Math.round(elapsedMs / 1000))}s）`;
      if (state.verifyCommand === undefined) {
        record.protocol.appendProgress({
          userPrompt: record.prompt,
          toolFailures: failures.count,
          failedTools: failures.names,
          verify: 'skipped',
          verifyDetail: '未配置 verifyCommand',
          note,
        });
        return;
      }
      const verify = await record.protocol.verify();
      record.protocol.appendProgress({
        userPrompt: record.prompt,
        toolFailures: failures.count,
        failedTools: failures.names,
        verify: verify.ok ? 'passed' : 'failed',
        verifyDetail: verify.timedOut ? '超时' : `exit=${String(verify.exitCode ?? 'null')}`,
        note,
      });
    } catch {
      // 进度是增强：写盘/验证失败绝不掩盖回合本身的异常与结果。
    }
  }

  /**
   * 为 `TurnRunner` 组装完成闸门：在既有闸门外层补一道「先验证再结束」。
   * @param sessionId 会话 id。
   * @param inner 既有完成闸门（可缺省）。
   * @param lastFailure 写时自验证的最近失败读取器（可缺省）。
   * @returns 包装后的闸门；本会话未启用长时程协议时原样返回 `inner`。
   */
  public checklistFor(
    sessionId: string,
    inner?: CompletionGate | undefined,
    lastFailure?: ((sessionId: string) => string | undefined) | undefined,
  ): CompletionGate | undefined {
    const record = this.records.get(sessionId);
    if (record === undefined) {
      return inner;
    }
    return new PreCompletionChecklist({
      protocol: record.protocol,
      ...(inner !== undefined ? { inner } : {}),
      ...(lastFailure !== undefined ? { lastFailure } : {}),
    });
  }

  /**
   * 本会话当前的功能清单（只读；未启用/未初始化时为空）。
   * @param sessionId 会话 id。
   * @returns 功能数组（可供 UI/测试查看，不修改状态）。
   */
  public featuresOf(sessionId: string): readonly LongHorizonFeature[] {
    return this.records.get(sessionId)?.protocol.read().features ?? [];
  }

  /**
   * 构造本轮协议（slug/verify 来自显式 env，缺省按会话 id 派生）。
   * @param prompt 本轮用户提示。
   * @param sessionId 会话 id。
   * @returns 协议实例。
   */
  private buildProtocol(prompt: string, sessionId: string): LongHorizonProtocol {
    const explicitSlug = this.env['OMNI_LONG_HORIZON_TASK'];
    const slug =
      explicitSlug !== undefined && isValidSlug(explicitSlug) ? explicitSlug : slugFor(sessionId);
    const verifyCommand = this.env['OMNI_LONG_HORIZON_VERIFY'];
    return new LongHorizonProtocol({
      workspaceRoot: this.workspaceRoot,
      slug,
      title: titleOfPrompt(prompt),
      ...(verifyCommand !== undefined && verifyCommand.trim() !== ''
        ? { verifyCommand: verifyCommand.trim() }
        : {}),
      seedFeatures: seedFeaturesFromPrompt(prompt),
      ...(this.now !== undefined ? { now: this.now } : {}),
    });
  }

  /**
   * 统计本回合工具失败（配对 `tool_call.name` 与 `tool_result.ok === false`）。
   * @param events 本回合事件切片。
   * @returns 失败次数与去重后的工具名。
   */
  public static toolFailuresOf(events: readonly SessionEvent[]): LongHorizonToolFailures {
    const callNames = new Map<string, string>();
    const names: string[] = [];
    let count = 0;
    for (const event of events) {
      const payload = event.payload as Record<string, unknown> | null | undefined;
      if (payload === null || payload === undefined) continue;
      const callId = payload['callId'];
      if (event.type === 'tool_call' && typeof callId === 'string') {
        const name = payload['name'];
        if (typeof name === 'string') callNames.set(callId, name);
        continue;
      }
      if (event.type !== 'tool_result' || typeof callId !== 'string') continue;
      if (payload['ok'] !== false) continue;
      count += 1;
      const name = callNames.get(callId) ?? 'unknown';
      if (!names.includes(name) && names.length < MAX_FAILED_TOOL_NAMES) {
        names.push(name);
      }
    }
    return { count, names };
  }
}
