/**
 * verdict 观测 + trace 落盘（Laya 战略线 · §34.7）：把「System-1 noul 预判」的观测与
 * 「配对 trace 落盘」从自验证装饰器里抽出来，单职负责质量信号的采集与 fail-open 记录，
 * 让装饰器回归「跑测试 + 回灌」的单一职责、并降低其方法/字段数（避免上帝类）。
 *
 * fail-open 取向：预判引擎不可用 / 抛错、trace 落盘失败，一律静默跳过，绝不阻断主流程
 * （与护栏 fail-closed 取向不同——这里是质量信号、非安全边界）。
 */
import type { ToolCall, ToolContext } from '../../../ports/tool/tool.js';
import type { DecisionEngine, DecisionResponse } from '../../../ports/decision/decisionEngine.js';
import type { DecisionTracePort } from '../../../ports/decision/decisionTrace.js';
import type { VerdictObserver } from './verdictTypes.js';

/** verdict 采集装配项（全部由组合根经自验证装饰器透传）。 */
export interface VerdictTracerWiring {
  /** 决策引擎（Laya）：跑测试前做一次 noul 预判。undefined 表示不接。 */
  readonly predictor?: DecisionEngine | undefined;
  /** verdict 观测回调（shadow 档记录一致性，不阻断主流程）。 */
  readonly observer?: VerdictObserver | undefined;
  /** 决策引擎生效模式：shadow（仅观测）/ enforce（回灌预判）。undefined 表示不接 verdict。 */
  readonly mode?: 'shadow' | 'enforce' | undefined;
  /** 决策 trace 落盘端口（配对样本）。undefined 表示不落盘。 */
  readonly trace?: DecisionTracePort | undefined;
  /** 可注入时钟（缺省 Date.now）。 */
  readonly now: () => number;
}

/**
 * verdict 观测 + trace 落盘：单职采集「System-1 预判 vs 真实测试结果」配对样本。
 *
 * 设计取向（为什么独立成类）：把质量信号的采集从「自验证装饰器」拆出，
 * 既让装饰器职责收敛（跑测试 + 回灌），也把本类的字段/方法从装饰器里移走（降上帝类风险）。
 */
export class VerdictTracer {
  /** 决策引擎（Laya），可选。 */
  private readonly predictor: DecisionEngine | undefined;
  /** verdict 观测回调（shadow 档）。 */
  private readonly observer: VerdictObserver | undefined;
  /** 决策引擎生效模式（shadow / enforce）。 */
  private readonly verdictMode: 'shadow' | 'enforce' | undefined;
  /** 决策 trace 落盘端口（配对样本）。 */
  private readonly trace: DecisionTracePort | undefined;
  /** 时钟。 */
  private readonly now: () => number;

  /**
   * @param wiring 装配项（引擎 / observer / 模式 / trace 端口 / 时钟）。
   */
  public constructor(wiring: VerdictTracerWiring) {
    this.predictor = wiring.predictor;
    this.observer = wiring.observer;
    this.verdictMode = wiring.mode;
    this.trace = wiring.trace;
    this.now = wiring.now;
  }

  /**
   * 当前生效模式（shadow / enforce / undefined）。
   *
   * @returns 装配时给定的模式；未接 verdict 时为 undefined。
   */
  public get mode(): 'shadow' | 'enforce' | undefined {
    return this.verdictMode;
  }

  /**
   * 跑测试前做一次 Laya noul 预判，并把 shadow 档观测交给 observer。
   *
   * 决策引擎不可用 / 抛错时静默返回 `{ noul: undefined, available: false }`（fail-open）。
   *
   * @param call 本次工具调用（供构造 state 摘要）。
   * @param context 工具上下文。
   * @returns noul 预判值（[0,1]）；不可用 / 退化时为 undefined，及引擎是否可用。
   */
  public async observe(
    call: ToolCall,
    context: ToolContext,
  ): Promise<{ noul: number | undefined; available: boolean }> {
    const predictor = this.predictor;
    if (predictor === undefined) {
      return { noul: undefined, available: false };
    }
    let available = false;
    try {
      available = !!(await predictor.isAvailable());
    } catch {
      return { noul: undefined, available: false };
    }
    if (!available) {
      return { noul: undefined, available: false };
    }
    const state = `tool=${call.name}; args=${JSON.stringify(call.arguments)}`;
    let response: DecisionResponse;
    try {
      response = await predictor.decide({
        state,
        questions: {
          passTest: {
            kind: 'noul',
            instructions: '这次源码改动会跑通既有测试吗？',
          },
        },
      });
    } catch {
      return { noul: undefined, available };
    }
    if (!response.available) {
      return { noul: undefined, available };
    }
    const noul = response.answers['passTest']?.noul;
    // shadow 档 telemetry：观测记录交给 observer（不阻断主流程；observer 抛错也静默）。
    if (this.observer !== undefined) {
      try {
        this.observer({ sessionId: context.sessionId, toolName: call.name, noul, available: true });
      } catch {
        // fail-open：telemetry 异常不得影响主流程。
      }
    }
    return { noul, available: true };
  }

  /**
   * 落盘一条配对 trace（预判 vs 真实结果），供离线校准/评估。
   *
   * 仅当 verdict 引擎启用（mode 非空）且 trace 端口已注入时记录；落盘异常静默（fail-open）。
   *
   * @param call 本次工具调用。
   * @param context 工具上下文。
   * @param noul Laya noul 预判（[0,1]）；不可用为 undefined。
   * @param available 决策引擎是否可用。
   * @param testRan 真实测试是否实际执行。
   * @param testPassed 真实测试是否通过（testRan=false 时 undefined）。
   * @param testExitCode 真实测试退出码（testRan=false 时 undefined）。
   * @returns 无返回值。
   */
  public emit(
    call: ToolCall,
    context: ToolContext,
    noul: number | undefined,
    available: boolean,
    testRan: boolean,
    testPassed: boolean | undefined,
    testExitCode: number | undefined,
  ): void {
    const sink = this.trace;
    const mode = this.verdictMode;
    if (sink === undefined || mode === undefined) {
      return;
    }
    try {
      sink.record({
        sessionId: context.sessionId,
        toolName: call.name,
        mode,
        noul,
        available,
        testRan,
        testPassed,
        testExitCode,
        at: this.now(),
      });
    } catch {
      // fail-open：trace 落盘异常不得影响主流程。
    }
  }
}
