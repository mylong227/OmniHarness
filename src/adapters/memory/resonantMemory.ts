import type {
  LongTermMemoryPort,
  MemoryFact,
  MemoryFactPatch,
} from '../../ports/longTermMemory.js';
import type { ResonantHit, ResonantMemoryPort } from '../../ports/resonantMemory.js';
import { eigenSpectrum, resonance, type Spectrum } from '../../util/eigenspectrum.js';

/**
 * 燧-3 共振寻址引擎：包装任意 `LongTermMemoryPort`，为每条事实预计算本征频谱，
 * 用频率域余弦（共振）召回。zero-dependency、惰性重建（事实变更后 dirty 重建）。
 *
 * 这是与 BM25（几何距离）完全不同的寻址代数：探针可以是纯频率签名（非自然语言），
 * 且对频率偏移有平滑频响——几何检索器无法表达。
 *
 * 本引擎**同时实现 `LongTermMemoryPort`**：即作为长期记忆端口的零侵入 drop-in 替换，
 * 委托标准读写给 base、仅把 `recall` 重写为共振寻址。装配层（ConfigFactory）在
 * `resonance.enabled` 时把 `config.longTermMemory` 封包为本引擎，Agent 主循环
 * （开场 primer 召回、recall 工具、回合末蒸馏）经同一端口即自动走共振代数——
 * 燧-3 从"端口"变为"真能力"，无需改动任何核心逻辑。
 */
export class ResonantMemoryEngine implements ResonantMemoryPort, LongTermMemoryPort {
  readonly name = 'resonant-memory';

  private readonly spectra = new Map<string, Spectrum>();
  private dirty = true;

  constructor(
    private readonly base: LongTermMemoryPort,
    private readonly bins = 257,
  ) {}

  private rebuild(): void {
    this.spectra.clear();
    for (const f of this.base.all()) {
      this.spectra.set(f.id, eigenSpectrum(f.text, this.bins));
    }
    this.dirty = false;
  }

  resonate(probe: Spectrum, k: number): readonly ResonantHit[] {
    if (k <= 0) return [];
    if (this.dirty) this.rebuild();
    const hits: ResonantHit[] = [];
    for (const f of this.base.all()) {
      const s = this.spectra.get(f.id);
      if (s === undefined) continue;
      hits.push({ fact: f, score: resonance(s, probe) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  resonateByText(query: string, k: number): readonly ResonantHit[] {
    return this.resonate(eigenSpectrum(query, this.bins), k);
  }

  // ── LongTermMemoryPort 委托 + 共振召回（drop-in 替换） ──

  /** 写入并标记脏：下次共振前重建本征谱。 */
  remember(fact: MemoryFact): void {
    this.base.remember(fact);
    this.dirty = true;
  }

  /**
   * 共振召回：把自然语言查询映射成频谱探针，返回共振度最高的 k 条事实
   * （同频即显、异频即散）。取代 base 的 BM25 几何召回。
   */
  recall(query: string, k: number): readonly MemoryFact[] {
    return this.resonateByText(query, k).map((h) => h.fact);
  }

  all(): readonly MemoryFact[] {
    return this.base.all();
  }

  get count(): number {
    return this.base.count;
  }

  get(id: string): MemoryFact | undefined {
    return this.base.get(id);
  }

  update(id: string, patch: MemoryFactPatch): boolean {
    const ok = this.base.update(id, patch);
    if (ok) this.dirty = true;
    return ok;
  }

  delete(id: string): boolean {
    const ok = this.base.delete(id);
    if (ok) this.dirty = true;
    return ok;
  }

  /**
   * 燧-3 调谐（autoRun 用）：强制重算全部本征谱，返回事实数与簇数（守恒自检：
   * 二者应相等，否则说明重建与 base 状态不一致）。供 SparkController 任务末统一调谐。
   */
  tune(): { readonly facts: number; readonly clusters: number } {
    this.rebuild();
    return { facts: this.base.all().length, clusters: this.spectra.size };
  }
}
