import { randomUUID } from 'node:crypto';
import type { RuntimeTelemetryPort } from '../ports/runtime/runtimeTelemetry.ts';
import type { SparkCycleReport } from './sparkController.ts';

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
   * 指标计算抽成两个**纯函数**段（coreMetrics / capabilityMetrics），本方法只做「序列化落盘」
   * ——此前本体 97 行贴函数上限，且每加一个引擎都要在 try 块里长一截（2026-10-31 拆分）。
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
      for (const { operator, metrics } of [
        ...SparkCycleTelemetry.coreMetrics(report),
        ...SparkCycleTelemetry.capabilityMetrics(report),
      ]) {
        emit(operator, metrics);
      }
    } catch {
      // 遥测是尽力而为，失败时绝不连累主任务
    }
  }

  /**
   * 核心腿指标（emit 的纯函数抽出段）：退火 / 免疫 / 信念 / 对称破缺。
   * @param report 本轮报告。
   * @returns 已启用引擎的（operator, metrics）序列。
   */
  private static coreMetrics(report: SparkCycleReport): {
    readonly operator: string;
    readonly metrics: Record<string, number>;
  }[] {
    const out: { readonly operator: string; readonly metrics: Record<string, number> }[] = [];
    const anneal = report.anneal;
    if (anneal !== undefined) {
      out.push({
        operator: 'heatAnnealer',
        metrics: { temperature: anneal.temperature, facts: anneal.facts, drift: anneal.drift },
      });
    }
    const immune = report.immune;
    if (immune !== undefined) {
      const la = immune.lastAnomaly;
      out.push({
        operator: 'immuneMonitoring',
        metrics: {
          lastAnomaly: la ? la.score : 0,
          anomalyScore: la ? la.score : 0,
          missedAnomaly: 0,
        },
      });
    }
    const belief = report.belief;
    if (belief !== undefined) {
      out.push({
        operator: 'belief',
        metrics: {
          klNG: belief.naturalGradient?.kl?.total ?? 0,
          klPF: belief.particleFilter?.kl?.total ?? 0,
          confidenceNG: belief.naturalGradient?.after?.confidence ?? 0,
          confidencePF: belief.particleFilter?.after?.confidence ?? 0,
        },
      });
    }
    const symmetry = report.symmetry;
    if (symmetry !== undefined) {
      const rho = symmetry.orderParameter ?? 0;
      out.push({
        operator: 'symmetryBreaking',
        metrics: { orderParameter: rho, rho, threshold: 0.6, falseBreak: 0 },
      });
    }
    return out;
  }

  /**
   * 能力腿指标（emit 的纯函数抽出段）：禁闭 / 元素组合 / CRISPR / 相变固化。
   * @param report 本轮报告。
   * @returns 已启用引擎的（operator, metrics）序列。
   */
  private static capabilityMetrics(report: SparkCycleReport): {
    readonly operator: string;
    readonly metrics: Record<string, number>;
  }[] {
    const out: { readonly operator: string; readonly metrics: Record<string, number> }[] = [];
    const confinement = report.confinement;
    if (confinement !== undefined) {
      out.push({
        operator: 'confinement',
        metrics: { exposed: confinement.exposed ? 1 : 0, confined: confinement.exposed ? 0 : 1 },
      });
    }
    const elementComposer = report.elementComposer;
    if (elementComposer !== undefined) {
      out.push({
        operator: 'elementComposer',
        metrics: {
          validCombo: elementComposer.compound ? 1 : 0,
          compound: elementComposer.compound ? 1 : 0,
          elements: elementComposer.elements,
        },
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
      out.push({ operator: 'crispr', metrics: { applied, rolledBack } });
    }
    const crystallizer = report.crystallizer;
    if (crystallizer !== undefined) {
      const ems = crystallizer.emergences;
      const meanEm = ems.length > 0 ? ems.reduce((a, b) => a + b, 0) / ems.length : 0;
      out.push({
        operator: 'capabilityCrystallizer',
        metrics: {
          frozen: crystallizer.frozen.length,
          alreadyFrozen: crystallizer.alreadyFrozen,
          skipped: crystallizer.skipped.length,
          emergence: meanEm,
          emergenceAccepted: ems.length - crystallizer.rejectedByFloor,
          emergenceRejected: crystallizer.rejectedByFloor,
          // 本轮回合真正调用 composeByTwist 的组合数（已冻结跳过的不计），用于收紧时区分真涌现与空轮。
          emergenceComposed: ems.length,
        },
      });
    }
    return out;
  }
}
