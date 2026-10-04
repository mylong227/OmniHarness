/**
 * 进化信号采集器（GEE Kernel v1 · ① ingest 环的实现，ADR-0008）。
 *
 * 解决的问题（信号源自参考）：`FailurePatternMiner` 此前只见**门禁拒绝的候选**——
 * 进化系统从未见过真实任务的失败/成功数据。本器把 `RuntimeTelemetryPort` 的
 * production 观测行提炼为进化信号：失败喂失败模式挖掘器（防再犯方向），
 * 成功组合喂相变固化器（组合密度方向）——「机制择优报告」所称的双源信号归纳。
 *
 * 映射规则（确定性，钉死在判据里）：
 * - **来源纪律**：只有 `provenance === 'production'` 的观测行可成信号（遥测诚实边界）；
 *   `seed-bootstrap` / `synthetic-lab` 行被消费但不产出——进化不得从合成数据自我感动。
 * - **verdict → 种类**：`fail` / `constrained` → failure（约束触发也是值得挖掘的摩擦）；
 *   `pass` → 仅当 `configSnapshot.skills` 携带 ≥2 个技能名时产出 success 信号
 *   （组合密度信号面约定：发射方把本轮命中的技能名放进观测行 `configSnapshot.skills`）。
 * - **游标消费**：观测行按链 `seq` 推进游标，同一条行绝不出两次信号；单次采集量
 *   受 `maxBatch` 硬上限（有界缓冲）。
 *
 * fail-closed：遥测端口缺失 / 读取抛错 → 返回空信号流（绝不连累调用方）。
 *
 * @maturity L1 — 信号面接线真实（生产行→信号→挖掘器/固化器有端到端判据）；增益假设未验证
 * @maturityEvidence tests/unit/evolutionSignal.test.ts
 */
import type {
  RuntimeObservation,
  RuntimeTelemetryPort,
} from '../ports/runtime/runtimeTelemetry.js';
import type { EvolutionSignal, EvolutionSignalSourcePort } from '../ports/runtime/evolution.js';

/** 信号采集器选项。 */
export interface EvolutionSignalCollectorOptions {
  /** 遥测端口（信号数据源；缺省 = 恒空信号流，掐断信号源的安全旁路）。 */
  readonly telemetry?: RuntimeTelemetryPort | undefined;
  /** 单次 `collect()` 最多消费的新观测行数（默认 256，有界缓冲）。 */
  readonly maxBatch?: number | undefined;
  /** success 信号要求的组合最小成员数（默认 2，与固化器口径一致）。 */
  readonly minCombinationSize?: number | undefined;
}

/** 进化信号采集器：production 观测行 → 确定性、有界的进化信号流。 */
export class EvolutionSignalCollector implements EvolutionSignalSourcePort {
  /** 遥测端口（数据源）。 */
  private readonly telemetry: RuntimeTelemetryPort | undefined;
  /** 单次采集上限。 */
  private readonly maxBatch: number;
  /** success 组合最小成员数。 */
  private readonly minCombinationSize: number;
  /** 已消费游标：`seq ≤ lastSeq` 的观测行不再产出信号。 */
  private lastSeq = 0;

  /**
   * @param opts 遥测端口 / 采集上限 / 组合最小成员数（缺省各取保守默认）
   */
  public constructor(opts: EvolutionSignalCollectorOptions = {}) {
    this.telemetry = opts.telemetry;
    this.maxBatch = Math.max(1, Math.floor(opts.maxBatch ?? 256));
    this.minCombinationSize = Math.max(2, Math.floor(opts.minCombinationSize ?? 2));
  }

  /**
   * 采集自上次以来的新信号：按链序推进游标消费新观测行，逐行映射为信号
   * （provenance 纪律 + verdict 映射，见模块注释）；游标在读取抛错时**不推进**（下次重读）。
   * @returns 新信号流（按观测行到达序；空数组 = 无新信号 / 信号源缺失 / 读取失败）
   */
  public collect(): readonly EvolutionSignal[] {
    if (this.telemetry === undefined) return [];
    let rows: readonly RuntimeObservation[];
    try {
      rows = this.telemetry.read();
    } catch {
      return [];
    }
    const out: EvolutionSignal[] = [];
    let consumed = 0;
    for (const row of rows) {
      if (consumed >= this.maxBatch) break;
      const seq = row.seq;
      if (seq === undefined || seq <= this.lastSeq) continue;
      consumed += 1;
      this.lastSeq = seq;
      if (row.provenance !== 'production') continue;
      const signal = this.signalFor(row);
      if (signal !== undefined) out.push(signal);
    }
    return out;
  }

  /**
   * 单条观测行 → 信号（映射规则见模块注释；无信号维度时返回 undefined）。
   * @param row production 观测行
   * @returns 信号；该行不携带任何信号维度时为 undefined
   */
  private signalFor(row: RuntimeObservation): EvolutionSignal | undefined {
    if (row.verdict === 'pass') {
      const combination = this.combinationOf(row);
      return combination === undefined ? undefined : this.successSignal(row, combination);
    }
    if (row.verdict === 'fail' || row.verdict === 'constrained') {
      return this.failureSignal(row);
    }
    return undefined;
  }

  /**
   * 失败信号：签名键与挖掘器聚类口径同构（`telemetry:<种类> × <算子>`），
   * 载荷与 `FailurePatternMiner` 的 `FailureRecord` 结构同形（直通喂挖掘器）。
   * @param row production 观测行（verdict = fail/constrained）
   * @returns 失败信号
   */
  private failureSignal(row: RuntimeObservation): EvolutionSignal {
    const kind = `telemetry:${row.kind}`;
    const metrics = this.metricsSummary(row);
    const verdict = row.verdict ?? 'fail';
    const message = `operator=${row.operator} verdict=${verdict}${metrics}`;
    return {
      kind: 'failure',
      key: `${kind} × ${row.operator}`,
      evidence: message,
      provenance: row.provenance,
      failure: { kind, location: row.operator, message },
    };
  }

  /**
   * 成功信号：组合键与固化器 `comboKey` 同构（成员去重升序 `|` 连接），
   * 载荷 combination 直通 `CapabilityCrystallizer.observe`。
   * @param row production 观测行（verdict = pass 且携带 skills）
   * @param combination 规范化组合（去重升序）
   * @returns 成功信号
   */
  private successSignal(row: RuntimeObservation, combination: readonly string[]): EvolutionSignal {
    const key = combination.join('|');
    return {
      kind: 'success',
      key,
      evidence: `composition pass: ${key}（operator=${row.operator}）`,
      provenance: row.provenance,
      success: { combination },
    };
  }

  /**
   * 从观测行 `configSnapshot.skills` 提取规范化组合（未知形状一律视为无组合）。
   * @param row 观测行
   * @returns 去重升序组合；成员数不足 `minCombinationSize` 或形状非法时 undefined
   */
  private combinationOf(row: RuntimeObservation): readonly string[] | undefined {
    const raw: unknown = row.configSnapshot['skills'];
    if (!Array.isArray(raw)) return undefined;
    const names: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') return undefined;
      names.push(item);
    }
    const unique = [...new Set(names)].sort();
    return unique.length >= this.minCombinationSize ? unique : undefined;
  }

  /**
   * 指标摘要（键名字典序拼接，保证同观测恒同摘要——确定性）。
   * @param row 观测行
   * @returns ` metrics: k=v;...`（无指标为空串）
   */
  private metricsSummary(row: RuntimeObservation): string {
    const keys = Object.keys(row.metrics).sort();
    if (keys.length === 0) return '';
    const parts = keys.map((k) => `${k}=${String(row.metrics[k])}`);
    return ` metrics: ${parts.join(';')}`;
  }
}
