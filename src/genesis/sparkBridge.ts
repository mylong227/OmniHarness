/**
 * Genesis ↔ Spark 桥接器（自适应编排落地）。
 *
 * 把上一轮的"孤立数学内核"真正接入活运行时：
 *   `GenesisSparkBridge.cycle(signals)` 返回与 `SparkController.cycle()` **同构**的
 *   `SparkCycleReport`，但发射顺序由 `planHarnessRegime(regime)` 按工况纯函数决定，
 *   且每一笔成本进入 `Ledger` 守恒账本（Landauer/Toyabe 落地）。
 *
 * 与既有 `SparkController` 的关系：当配置 `genesis.enabled` 时，RuntimeFactory 构造本桥
 * 并注入 SparkController；`cycle()` 在开头委托本桥（fail-closed：桥异常不连累主任务）。
 * 默认不启用 ⇒ 完全沿用既有行为，零回归。
 */

import type { SparkCycleReport } from '../spark/sparkController.js';
import { Ledger } from './ledger.js';
import {
  type HarnessState,
  type RegimeSignals,
  type SparkEngines,
  HARNESS_OPERATORS,
  planHarnessRegime,
  deriveRegime,
} from './operators.js';

/** 算子名 → SparkCycleReport 字段（同构映射）。 */
const REPORT_FIELD: Readonly<Record<string, keyof SparkCycleReport>> = {
  resonance: 'resonance',
  vortex: 'vortex',
  heatAnnealer: 'anneal',
  web: 'web',
  qec: 'qec',
  immuneMonitoring: 'immune',
  belief: 'belief',
  crispr: 'crispr',
  capabilityCrystallizer: 'crystallizer',
  etching: 'etching',
  elementComposer: 'elementComposer',
  symmetryBreaking: 'symmetry',
  confinement: 'confinement',
};

/** 由工况信号构造初始 Harness 状态。 */
export function initialState(signals: RegimeSignals): HarnessState {
  return {
    temperature: 1,
    orderParameter: 0,
    exposed: false,
    entropy: signals.entropy,
    modalityCount: signals.modalityCount,
    costAccumTokens: 0,
    successRate: signals.successRate,
  };
}

/**
 * 自适应编排桥：一次 cycle 的真实执行。
 * 返回 SparkCycleReport（ran=false 当无引擎触发），并暴露 lastLedger 供守恒校验。
 */
export class GenesisSparkBridge {
  /** 最近一次 cycle 的账本（守恒校验用；未跑为 undefined）。 */
  public lastLedger: Ledger | undefined;

  public constructor(private readonly engines: SparkEngines) {}

  public cycle(signals: RegimeSignals): SparkCycleReport {
    const regime = deriveRegime(signals);
    const order = planHarnessRegime(regime);
    let state = initialState(signals);
    const ledger = new Ledger();
    const frags: Record<string, unknown> = {};
    let ran = false;
    for (const name of order) {
      const op = HARNESS_OPERATORS[name];
      if (op === undefined) continue;
      const r = op(state, this.engines);
      ledger.record(r.cost);
      ledger.commit();
      state = r.next;
      if (r.report !== undefined) {
        frags[name] = r.report;
        ran = true;
      }
    }
    this.lastLedger = ledger;
    const report = { ran } as unknown as SparkCycleReport;
    for (const [name, frag] of Object.entries(frags)) {
      const field = REPORT_FIELD[name];
      if (field !== undefined) {
        (report as unknown as Record<string, unknown>)[field as string] = frag;
      }
    }
    return report;
  }
}
