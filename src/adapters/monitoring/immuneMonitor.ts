/**
 * @maturity L0 — 框架在；未与 prompt injection 对抗集（AgentDojo/InjecAgent）接通
 * @maturityEvidence tests/unit/immuneMonitor.test.ts
 */
import type { ImmuneMonitorPort, AnomalyAlert, ImmuneSelfReport } from '../../ports/immune.js';
import type { AuditSinkLike } from '../../ports/supervisor.js';

/** 免疫监控选项（fail-closed 边界夹紧）。 */
export interface ImmuneMonitorOptions {
  /** 异常判定阈值（z 分数）；超过即偏离自体。默认 3。 */
  readonly threshold?: number;
  /** 记忆细胞加速步长：同一签名每出现一次，阈值下调该比例（上限 0.5）。默认 0.1。 */
  readonly accelStep?: number;
  /** 审计 sink（可选）：异常经此入链告警（fail-closed：仅告警不改写）。 */
  readonly audit?: AuditSinkLike;
  /** 会话标识（写入审计 detail）。 */
  readonly sessionId?: string;
}

const MIN_TRAIN = 4;

/**
 * 免疫异常监控器（Immune Monitoring，I-P1-5）。仿 Dasgupta 阴性选择。
 *
 * - **自体检测器**：`train` 用 Welford 在线估计各维均值/方差与容忍界（自体分布）。
 * - **偏离即告警**：`observe` 计算与自体的 z 距离，超阈值→告警；多点偏离按签名形成记忆细胞，
 *   二次出现时阈值下调（加速响应，仿免疫记忆）。
 * - **自检**：`selfCheck` 返回自体规模与最近异常；告警经 AuditSink 入链（fail-closed，不擅自改写）。
 *
 * 零运行时依赖；与规则阈值监控在代数上不同——这是学习型自体分布监控（市面唯一）。
 */
export class ImmuneMonitor implements ImmuneMonitorPort {
  /** 端口名：免疫异常监控标识，与 ImmuneMonitorPort 契约的命名空间一致。 */
  public readonly name = 'immune-monitor';
  private readonly threshold: number;
  private readonly accelStep: number;
  private readonly audit?: AuditSinkLike;
  private readonly sessionId?: string;

  private n = 0;
  private dim = 0;
  private readonly mean: number[] = [];
  private readonly M2: number[] = [];
  private readonly cells = new Map<string, number>();
  private lastAnomaly: AnomalyAlert | null = null;

  public constructor(opts: ImmuneMonitorOptions = {}) {
    this.threshold = Math.max(0.5, opts.threshold ?? 3);
    this.accelStep = clamp(opts.accelStep ?? 0.1, 0, 0.5);
    this.audit = opts.audit;
    this.sessionId = opts.sessionId;
  }

  /**
   * 用正常行为样本训练自体检测器：Welford 在线估计各维均值/方差（自体分布基线）。
   * @param sample 单个正常行为特征样本（训练样本数达 4 后 observe 才有基线可用）。
   */
  public train(sample: readonly number[]): void {
    // Welford：每样本 n 仅 +1（不可按维度累加，否则多维样本会倍数膨胀自体规模）。
    this.n++;
    for (let i = 0; i < sample.length; i++) {
      if (i >= this.dim) {
        this.dim = i + 1;
        this.mean.push(0);
        this.M2.push(0);
      }
      const x = sample[i]!;
      const delta = x - this.mean[i]!;
      this.mean[i] = this.mean[i]! + delta / this.n;
      this.M2[i] = this.M2[i]! + delta * (x - this.mean[i]!);
    }
  }

  /**
   * 观察一个行为样本：取与自体分布各维 z 距离的最大值为异常度，超过有效阈值（记忆细胞
   * 按偏离签名下调后）即告警——告警写入 AuditSink 并记为 lastAnomaly；同签名二次出现阈值
   * 进一步下调（加速响应）。无自体基线（训练样本 <4）返回 null。
   * @param sample 行为特征样本。
   * @returns 异常告警（异常度/签名/严重度）；正常或无基线返回 null。
   */
  public observe(sample: readonly number[]): AnomalyAlert | null {
    if (this.n < MIN_TRAIN || this.dim === 0) return null; // 无自体基线
    let score = 0;
    const exceeded: number[] = [];
    for (let i = 0; i < this.dim; i++) {
      const meanI = this.mean[i] ?? 0;
      const x = sample[i] ?? meanI;
      const std = Math.sqrt(this.M2[i]! / Math.max(this.n - 1, 1));
      const z = Math.abs(x - meanI) / Math.max(std, 1e-9);
      if (z > score) score = z;
      if (z >= this.threshold) exceeded.push(i);
    }
    const sig = `d${exceeded.sort((a, b) => a - b).join('-')}`;
    const seen = this.cells.get(sig) ?? 0;
    // 记忆细胞加速：同签名二次出现 → 阈值下调（最多 50%），更早响应。
    const eff = this.threshold * (1 - Math.min(0.5, seen * this.accelStep));
    if (score < eff) return null;
    const severity: 'warn' | 'critical' = score >= this.threshold * 2 ? 'critical' : 'warn';
    const alert: AnomalyAlert = { score, signature: sig, severity };
    this.cells.set(sig, seen + 1);
    this.lastAnomaly = alert;
    this.audit?.record({
      type: 'immune',
      sessionId: this.sessionId,
      detail: { score, signature: sig, severity },
    } as unknown as Parameters<AuditSinkLike['record']>[0]);
    return alert;
  }

  /** 自检：返回自体模型训练样本数与最近一次观测到的异常（无则 null）。 */
  public selfCheck(): ImmuneSelfReport {
    return { selfSize: this.n, lastAnomaly: this.lastAnomaly };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
