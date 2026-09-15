/**
 * A4 离线注入度量（零依赖，实验性 @beta）。
 *
 * 对「离线 curated 注入用例快照」跑 {@link scanForInjection}，算出
 * 检测率（recall）/ 误报率（false-positive）/ 精度（precision）与按类别、按来源拆分。
 * 纯函数、无副作用；快照不联网取 AgentDojo/InjecAgent（D4 主门禁禁联网），
 * 仅作护栏质量的离线代理信号。
 *
 * 度量口径：
 * - TP = 恶意且被拦截；FN = 恶意且放行；FP = 良性且被拦截；TN = 良性且放行。
 * - recall（检测率）= TP / (TP + FN)         —— 越高越好。
 * - falsePositiveRate = FP / (FP + TN)       —— 越低越好。
 * - precision = TP / (TP + FP)               —— 越高越好。
 *
 * **来源维度（P4 起）**：用例可带 `source`（内容来源信任级）；缺失时按 `unknown` 判定。
 * 判定阈值随来源变化（见 `ToolOutputTrust`），故报告 `bySource` 拆分会直接反映
 * 「外部抓取召回」与「本机命令误报」这两个 P4 目标量。
 *
 * 聚合细节见 `InjectionSnapshotAggregator`；本模块只做「逐例扫描 + 编排」。
 */
import { scanForInjection } from './promptInjectionGuard.js';
import {
  InjectionSnapshotAggregator,
  type CaseOutcome,
  type InjectionCase,
  type SnapshotReport,
} from './injectionSnapshotAggregator.js';

export type {
  CaseOutcome,
  CategoryStat,
  InjectionCase,
  SnapshotReport,
  SourceStat,
} from './injectionSnapshotAggregator.js';

/**
 * 对快照跑护栏并汇总度量（含按类别、按来源拆分）。
 *
 * @param cases 离线 curated 用例（可带 `source` 指定来源信任级）。
 * @returns 度量报告。
 */
export function evaluateSnapshot(cases: readonly InjectionCase[]): SnapshotReport {
  const aggregator = new InjectionSnapshotAggregator();
  const outcomes: CaseOutcome[] = [];
  for (const c of cases) {
    const tier = c.source ?? 'unknown';
    const scan = scanForInjection(c.text, tier);
    outcomes.push(aggregator.record(c, tier, scan.blocked, scan.score < 0 ? 0 : scan.score));
  }
  return aggregator.build(cases.length, outcomes);
}
