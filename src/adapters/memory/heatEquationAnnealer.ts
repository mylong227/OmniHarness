/**
 * @maturity L2 — 真做扩散步；冷却调度的最优性未证
 * @maturityEvidence tests/unit/heatAnnealer.test.ts
 */
import type { LongTermMemoryPort } from '../../ports/memory/longTermMemory.js';
import type { MemoryAnnealer, AnnealStepReport } from '../../ports/memory/memoryAnnealing.js';
import { eigenSpectrum, resonance, type Spectrum } from '../../util/eigenSpectrum.js';

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
  /** 退火器名称（标识此离散热方程实现）。 */
  public readonly name = 'heat-equation-annealer';
  /** 被写入重要性的底层长期记忆端口（退火结果直接回写）。 */
  private readonly memory: LongTermMemoryPort;
  /** 扩散系数 k：每步边耦合强度（高温下按 k·T 缩放）。 */
  private readonly coupling: number;
  /** 初始温度 T0：高温激进重排的起点。 */
  private readonly initialTemperature: number;
  /** 冷却时间常数 τ：T(t) = T0·exp(−t/τ) 的调度参数。 */
  private readonly coolingRate: number;
  /** 衰减率（遗忘）：孤立/未强化事实向地板 1 消退的速度。 */
  private readonly decay: number;
  /** 共振耦合阈值：仅共振度高于此值的节点对才连边（剪枝弱耦合长尾）。 */
  private readonly resonanceThreshold: number;
  /** 单步退火的事实数上限：超出只退火最重要的一批（防 O(n²) 爆炸）。 */
  private readonly maxFacts: number;
  /** 本征谱分箱数（须与共振引擎一致）。 */
  private readonly bins: number;

  /** 当前退火温度（每步按几何冷却下降）。 */
  private _temperature: number;
  /** 已执行的退火步数（单调递增）。 */
  private _steps = 0;
  /**
   * 解离集合（T3.2 三态循环）：触底事实的 id。解离后脱离耦合图（不收发扩散），
   * 只随外部 `update` 提升 importance 而复活（重新进入充能态）。
   */
  private readonly dissociated = new Set<string>();

  /**
   * @param memory 被退火的长期记忆端口（重要性读写均经它）。
   * @param opts 退火器选项（耦合/温度/冷却/衰减/阈值等，全有保守默认）。
   */
  public constructor(memory: LongTermMemoryPort, opts: HeatAnnealerOptions = {}) {
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

  /** 当前退火温度（0-1 区间的调度值，可观测/测试用）。 */
  public get temperature(): number {
    return this._temperature;
  }

  /** 已执行的退火步数。 */
  public get steps(): number {
    return this._steps;
  }

  /**
   * 执行一步退火：三态生命周期循环（T3.2，对齐耗散自组装）+ 扩散 + 衰减 + 冷却。
   *
   * 三态语义（每步对每条事实判定，计数进报告）：
   * - **充能 charged**：重要性上升（簇内共识增强）；或上步已解离但本步发现被外部
   *   `update` 提升到地板之上 → 自动复活并回到耦合图（充能态）。
   * - **衰减 decayed**：重要性下降但未触底（自然遗忘进行中，仍留在耦合图）。
   * - **解离 dissociated**：本次触底（退至地板）→ 进入解离集合，此后不再收发扩散，
   *   图规模随解离收缩（耗散自组装的「废料回收」腿），杜绝死事实污染共识。
   *
   * @returns 本步报告（步号、温度、参与数、总漂移、三态计数）
   */
  public anneal(): AnnealStepReport {
    this._steps += 1;
    const step = this._steps;

    let facts = this.memory.all();
    if (facts.length === 0) {
      this.cool();
      return {
        step,
        temperature: this._temperature,
        facts: 0,
        drift: 0,
        charged: 0,
        decayed: 0,
        dissociated: 0,
      };
    }

    // 封顶：超量则只退火当前最重要的一批（fail-closed 边界，防 O(n²) 爆炸）。
    if (facts.length > this.maxFacts) {
      facts = facts
        .slice()
        .sort((a, b) => b.importance - a.importance || (a.id < b.id ? -1 : 1))
        .slice(0, this.maxFacts);
    }

    const n = facts.length;
    const imp = facts.map((f) => f.importance);
    // 预计算每条事实的本征谱（复用燧-3 频率域工具），避免每对重复派生。
    const specs: Spectrum[] = facts.map((f) => eigenSpectrum(f.text, this.bins));

    // 复活腿：上步解离、但被外部更新充能到地板之上的事实 → 回到耦合图（计充能）。
    let charged = 0;
    for (const f of facts) {
      if (this.dissociated.has(f.id) && f.importance > FLOOR) {
        this.dissociated.delete(f.id);
        charged += 1;
      }
    }

    // 参与扩散的活性子集：非解离事实才收发热量（解离事实只剩外部充能一条复活路）。
    const activeIdx: number[] = [];
    for (let i = 0; i < n; i++) if (!this.dissociated.has(facts[i]!.id)) activeIdx.push(i);

    const T = this._temperature;
    const next = new Array<number>(n);

    for (const i of activeIdx) {
      const si = specs[i]!;
      const ii = imp[i]!;
      let coupled = 0;
      for (const j of activeIdx) {
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
    let decayed = 0;
    let dissociatedNow = 0;
    for (const i of activeIdx) {
      const before = imp[i]!;
      const after = next[i]!;
      drift += Math.abs(after - before);
      if (after > before) {
        charged += 1;
      } else if (after <= FLOOR) {
        // 触底 → 解离（脱离耦合图；外部 update 提升即复活）。
        this.dissociated.add(facts[i]!.id);
        dissociatedNow += 1;
      } else {
        decayed += 1;
      }
      this.memory.update(facts[i]!.id, { importance: after });
    }

    this.cool();
    return {
      step,
      temperature: this._temperature,
      facts: n,
      drift,
      charged,
      decayed,
      dissociated: dissociatedNow,
    };
  }

  /** 温度调度：T ← T0 · exp(−steps/τ)（几何冷却，单调下降、渐近趋 0）。
   * @returns 无返回值。
   */
  private cool(): void {
    this._temperature = this.initialTemperature * Math.exp(-this._steps / this.coolingRate);
  }
}
