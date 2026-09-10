import { randomUUID } from 'node:crypto';
import type { RuntimeTelemetryPort } from '../ports/runtimeTelemetry.js';
import type { SparkCycleReport } from './sparkController.js';

/**
 * 燧内核「长期运行遥测」发射器：把一轮 `SparkCycleReport` 按已启用引擎摊成生产观测落盘。
 *
 * 单一职责——只负责「报告 → 遥测记录」的映射与发射。
 * 遥测是尽力而为：未配置遥测端口或发射异常时静默返回，绝不连累主任务（fail-closed 旁路）。
 */
export class SparkCycleTelemetry {
  /**
   * @param telemetry 遥测端口（缺省则不发）
   * @param autoRun 当前 autoRun 配置（写入观测的 configSnapshot）
   */
  public constructor(
    private readonly telemetry: RuntimeTelemetryPort | undefined,
    private readonly autoRun: boolean,
  ) {}

  /**
   * 发射一轮报告：为每个已启用引擎落盘一条 `cycle` 观测（携带该引擎已算出的真实指标）。
   *
   * @param report 本轮 cycle 报告
   * @returns 无
   */
  public emit(report: SparkCycleReport): void {
    if (this.telemetry === undefined) {
      return;
    }
    const tel = this.telemetry;
    try {
      const emit = (operator: string, metrics: Record<string, number>): void => {
        tel.record({
          id: randomUUID(),
          kind: 'cycle',
          operator,
          configSnapshot: { autoRun: this.autoRun },
          metrics,
          verdict: 'pass',
          provenance: 'production',
        });
      };
      const anneal = report.anneal;
      if (anneal !== undefined) {
        emit('heatAnnealer', {
          temperature: anneal.temperature,
          facts: anneal.facts,
          drift: anneal.drift,
        });
      }
      const immune = report.immune;
      if (immune !== undefined) {
        const la = immune.lastAnomaly;
        emit('immuneMonitoring', {
          lastAnomaly: la ? la.score : 0,
          anomalyScore: la ? la.score : 0,
          missedAnomaly: 0,
        });
      }
      const belief = report.belief;
      if (belief !== undefined) {
        emit('belief', {
          klNG: belief.naturalGradient?.kl?.total ?? 0,
          klPF: belief.particleFilter?.kl?.total ?? 0,
          confidenceNG: belief.naturalGradient?.after?.confidence ?? 0,
          confidencePF: belief.particleFilter?.after?.confidence ?? 0,
        });
      }
      const symmetry = report.symmetry;
      if (symmetry !== undefined) {
        const rho = symmetry.orderParameter ?? 0;
        emit('symmetryBreaking', {
          orderParameter: rho,
          rho,
          threshold: 0.6,
          falseBreak: 0,
        });
      }
      const confinement = report.confinement;
      if (confinement !== undefined) {
        emit('confinement', {
          exposed: confinement.exposed ? 1 : 0,
          confined: confinement.exposed ? 0 : 1,
        });
      }
      const elementComposer = report.elementComposer;
      if (elementComposer !== undefined) {
        emit('elementComposer', {
          validCombo: elementComposer.compound ? 1 : 0,
          compound: elementComposer.compound ? 1 : 0,
          elements: elementComposer.elements,
        });
      }
      const crispr = report.crispr;
      if (crispr !== undefined) {
        let applied = 0;
        let rolledBack = 0;
        for (const c of crispr) {
          if (c.applied) applied += 1;
          if (c.rolledBack) rolledBack += 1;
        }
        emit('crispr', { applied, rolledBack });
      }
      const crystallizer = report.crystallizer;
      if (crystallizer !== undefined) {
        const ems = crystallizer.emergences;
        const meanEm = ems.length > 0 ? ems.reduce((a, b) => a + b, 0) / ems.length : 0;
        emit('capabilityCrystallizer', {
          frozen: crystallizer.frozen.length,
          alreadyFrozen: crystallizer.alreadyFrozen,
          skipped: crystallizer.skipped.length,
          emergence: meanEm,
          emergenceAccepted: ems.length - crystallizer.rejectedByFloor,
          emergenceRejected: crystallizer.rejectedByFloor,
          // 本轮回合真正调用 composeByTwist 的组合数（已冻结跳过的不计），用于收紧时区分真涌现与空轮。
          emergenceComposed: ems.length,
        });
      }
    } catch {
      // 遥测是尽力而为，失败时绝不连累主任务
    }
  }
}
