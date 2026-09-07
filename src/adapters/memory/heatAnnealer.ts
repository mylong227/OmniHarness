import type { LongTermMemoryPort } from '../../ports/longTermMemory.js';
import type { MemoryAnnealer, AnnealStepReport } from '../../ports/memoryAnnealing.js';
import { eigenSpectrum, resonance, type Spectrum } from '../../util/eigenspectrum.js';

/** 退火器选项（全部有保守默认；fail-closed 边界均夹紧）。 */
export interface HeatAnnealerOptions {
  /** 扩散系数 k（每步边耦合强度）。默认 0.15。 */
  readonly coupling?: number;
  /** 初始温度 T0（高温激进重排）。默认 1.0。 */
  readonly initialTemperature?: number;
  /** 冷却时间常数 τ：T(t) = T0 · exp(−t/τ)。默认 8。 */
  readonly coolingRate?: number;
  /** 衰减率（遗忘：孤立/未强化事实向地板 1 缓慢消退）。默认 0.02。 */
  readonly decay?: number;
  /** 共振耦合阈值：仅共振度 > 此值才连边（剪枝 O(n²) 长尾）。默认 0.35。 */
  readonly resonanceThreshold?: number;
  /** 封顶事实数（防 O(n²) 爆炸）：超出则只退火当前最重要的一批。默认 1500。 */
  readonly maxFacts?: number;
  /** 本征谱分箱（须与共振引擎一致，默认 257 质数防谐波别名）。 */
  readonly bins?: number;
}

const FLOOR = 1;
const CEIL = 5;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 离散热方程记忆退火器（Heat-Equation Memory Annealer）。
 *
 * 把长期记忆事实视为图节点，以频率域共振度为边权构建耦合矩阵 W。每步跑一次
 * 显式欧拉扩散（热方程离散形式）：
 *
 *   ΔI_i = k·T·Σ_j W_ij·(I_j − I_i)      // 扩散：簇内共识、簇间隔离
 *   I_i  ← clamp(I_i + ΔI_i − decay·T·max(0, I_i − FLOOR), 1, 5)  // 衰减遗忘
 *
 * - k·T 随温度线性缩放 → 高温激进重排、低温冻结（退火调度）。
 * - 共振度 > 阈值的边才保留，剪掉长尾弱耦合，控制重权方向。
 * - 孤立/未强化事实在衰减项下缓慢退向地板 1（自然遗忘），簇内因扩散项抵消衰减而留存。
 *
 * 零运行时依赖：耦合谱复用燧-3 的 eigenSpectrum/resonance。fail-closed：
 * 事实数 0 或超限时只退火最重要的一批，绝不越界；温度调度与漂移均为纯函数式推导。
 */
export class HeatEquationAnnealer implements MemoryAnnealer {
  readonly name = 'heat-equation-annealer';
  private readonly memory: LongTermMemoryPort;
  private readonly coupling: number;
  private readonly initialTemperature: number;
  private readonly coolingRate: number;
  private readonly decay: number;
  private readonly resonanceThreshold: number;
  private readonly maxFacts: number;
  private readonly bins: number;

  private _temperature: number;
  private _steps = 0;

  constructor(memory: LongTermMemoryPort, opts: HeatAnnealerOptions = {}) {
    this.memory = memory;
    this.coupling = clamp(opts.coupling ?? 0.15, 0.001, 1);
    this.initialTemperature = clamp(opts.initialTemperature ?? 1.0, 1e-4, 100);
    this.coolingRate = Math.max(1e-3, opts.coolingRate ?? 8);
    this.decay = clamp(opts.decay ?? 0.02, 0, 0.9);
    this.resonanceThreshold = clamp(opts.resonanceThreshold ?? 0.6, 0, 1);
    this.maxFacts = Math.max(1, Math.floor(opts.maxFacts ?? 1500));
    this.bins = opts.bins ?? 257;
    this._temperature = this.initialTemperature;
  }

  get temperature(): number {
    return this._temperature;
  }

  get steps(): number {
    return this._steps;
  }

  anneal(): AnnealStepReport {
    this._steps += 1;
    const step = this._steps;

    let facts = this.memory.all();
    if (facts.length === 0) {
      this.cool();
      return { step, temperature: this._temperature, facts: 0, drift: 0 };
    }

    // 封顶：超量则只退火当前最重要的一批（fail-closed 边界，防 O(n²) 爆炸）。
    if (facts.length > this.maxFacts) {
      facts = facts
        .slice()
        .sort((a, b) => b.importance - a.importance)
        .slice(0, this.maxFacts);
    }

    const n = facts.length;
    const imp = facts.map((f) => f.importance);
    // 预计算每条事实的本征谱（复用燧-3 频率域工具），避免每对重复派生。
    const specs: Spectrum[] = facts.map((f) => eigenSpectrum(f.text, this.bins));

    const T = this._temperature;
    const next = new Array<number>(n);

    for (let i = 0; i < n; i++) {
      const si = specs[i]!;
      const ii = imp[i]!;
      let coupled = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const w = resonance(si, specs[j]!);
        if (w > this.resonanceThreshold) {
          coupled += w * (imp[j]! - ii);
        }
      }
      // 扩散（热方程）+ 衰减遗忘（向地板 1 缓慢消退）。
      let v = ii + this.coupling * T * coupled - this.decay * T * Math.max(0, ii - FLOOR);
      next[i] = clamp(v, FLOOR, CEIL);
    }

    let drift = 0;
    for (let i = 0; i < n; i++) {
      const before = imp[i]!;
      const after = next[i]!;
      drift += Math.abs(after - before);
      this.memory.update(facts[i]!.id, { importance: after });
    }

    this.cool();
    return { step, temperature: this._temperature, facts: n, drift };
  }

  /** 温度调度：T ← T0 · exp(−steps/τ)（几何冷却，单调下降、渐近趋 0）。 */
  private cool(): void {
    this._temperature = this.initialTemperature * Math.exp(-this._steps / this.coolingRate);
  }
}
