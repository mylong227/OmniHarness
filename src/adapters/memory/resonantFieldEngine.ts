/**
 * 共振场统一引擎（U1 — ResonantField）。
 *
 * 把「燧-3 共振寻址」与「宇宙网」合并为单一装饰器，消除此前的**双重频谱索引**
 * （ResonantMemoryEngine 与 CosmicWebMemoryEngine 各自对每条事实算一份 eigenSpectrum）。
 * 本引擎只维护一份 `spectra: Map<factId, Spectrum>` + 一份 `clusters: Map<clusterId, Cluster>`，
 * 同时承担：共振寻址（resonate/fiber）、Burgers 黏附去重（remember）、RG 粗粒化坍缩
 * （consolidate）、调谐（tune）。落盘仍委托 base（FileLongTermMemory），坍缩后的抽象代表
 * 以 `topic='__web_abstract__'` 持久化——重启后由 seeding 部分恢复坍缩结构（相对宇宙网
 * 「重启丢坍缩骨干」更稳健）。
 *
 * 同时实现 `ResonantFieldPort` 与 `LongTermMemoryPort`：作为长期记忆端口的零侵入
 * drop-in 替换（委托标准读写给 base，仅把 `recall` 重写为共振寻址）。
 *
 * 零运行时依赖。
 *
 * @maturity L0 — 场强叠加在；与词袋冗余（实测零增益）
 * @maturityEvidence tests/unit/resonantField.test.ts
 */
import type {
  LongTermMemoryPort,
  MemoryFact,
  MemoryFactPatch,
} from '../../ports/memory/longTermMemory.js';
import type { ResonantHit, ResonantMemoryPort } from '../../ports/memory/resonantMemory.js';
import type { CosmicWebPort, WebConsolidationReport } from '../../ports/memory/cosmicWeb.js';
import type { ResonantFieldOptions, ResonantFieldPort } from '../../ports/memory/resonantField.js';
import { eigenSpectrum, resonance, type Spectrum } from '../../util/eigenspectrum.js';
import { rankWithDecay, type ScoredFact } from './timeDecay.js';
import { ResonantFieldMath } from './resonantFieldMath.js';

/** 共振簇：质心 + 成员事实 id（含是否已被抽象代表取代）。 */
interface Cluster {
  repId: string;
  centroid: Spectrum;
  members: string[];
  abstract: boolean;
}

/**
 * 共振场统一引擎。
 */
export class ResonantFieldEngine
  implements ResonantFieldPort, ResonantMemoryPort, CosmicWebPort, LongTermMemoryPort
{
  /** 端口名；本类同时实现共振场/共振寻址/宇宙网/长期记忆四端口，共用此命名空间。 */
  public readonly name = 'resonant-field';

  /** 单一频谱索引（消除双重频谱）。 */
  private readonly spectra = new Map<string, Spectrum>();
  /** 共振簇（拓扑，进程内）。 */
  private readonly clusters = new Map<string, Cluster>();
  /** 已登记的事实 id 全集（含仅入谱未落盘的黏附成员），用于去重与坍缩清理。 */
  private readonly knownIds = new Set<string>();
  /** 簇 id 自增序列号（保证簇 id 唯一且重启后继续递增）。 */
  private clusterSeq = 0;

  /** 黏附半径（共振度阈值）：新事实与簇共振≥此值则并入该簇而不落盘。 */
  private readonly adhesionThreshold: number;
  /** Bekenstein 容量界：簇数硬上限，超过即触发 RG 粗粒化坍缩。 */
  private readonly bekensteinCap: number;
  /** 纤维边阈值：两簇质心共振≥此值时计为一条纤维边。 */
  private readonly edgeThreshold: number;
  /** 本征谱分箱数：文本 → 频率谱的维度。 */
  private readonly bins: number;
  /** 时间衰减半衰期（天）：召回重排用的衰减参数。 */
  private readonly halfLifeDays: number;
  /** 时钟函数（毫秒时间戳），测试可注入固定时钟。 */
  private readonly clock: () => number;

  /**
   * @param base 被包装的底层长期记忆端口（标准读写与落盘全部委托给它）。
   * @param opts 引擎选项（阈值/容量界/分箱/半衰期/时钟，全有保守默认）。
   */
  public constructor(
    private readonly base: LongTermMemoryPort,
    opts: ResonantFieldOptions = {},
  ) {
    this.adhesionThreshold = ResonantFieldMath.clamp(opts.adhesionThreshold ?? 0.75, 0, 1);
    this.bekensteinCap = Math.max(1, Math.floor(opts.bekensteinCap ?? 64));
    this.edgeThreshold = ResonantFieldMath.clamp(opts.edgeThreshold ?? 0.4, 0, 1);
    this.bins = opts.bins ?? 257;
    this.halfLifeDays = opts.halfLifeDays ?? 90;
    this.clock = opts.clock ?? Date.now;
    this.seed();
  }

  /** 从 base 重新播种谱与簇（重启恢复；abstract 事实恢复为簇质心）。
   * @returns 无返回值。
   */
  private seed(): void {
    this.spectra.clear();
    this.clusters.clear();
    this.knownIds.clear();
    for (const f of this.base.all()) {
      const s = eigenSpectrum(f.text, this.bins);
      this.spectra.set(f.id, s);
      this.knownIds.add(f.id);
      if (f.topic === '__web_abstract__') {
        // 坍缩后的抽象代表 → 恢复为一个簇（质心取自代表文本）。
        const cid = `cl_${this.clusterSeq++}`;
        this.clusters.set(cid, { repId: f.id, centroid: s, members: [f.id], abstract: true });
      } else {
        const cid = `cl_${this.clusterSeq++}`;
        this.clusters.set(cid, { repId: f.id, centroid: s, members: [f.id], abstract: false });
      }
    }
  }

  // ── 写入：Burgers 黏附去重 + 建簇 ──

  /**
   * 写入一条事实：已知 id 仅刷新频谱索引；新事实与既有簇共振度 ≥ 黏附阈值时并入该簇
   * （Burgers 黏附去重，不重复写 base），否则写入 base 并登记为新簇质心。
   * @param fact 待写入的持久事实。
   * @returns 无返回值。
   */
  public remember(fact: MemoryFact): void {
    if (this.knownIds.has(fact.id)) {
      // 已存在：更新谱与所属簇。
      const s = eigenSpectrum(fact.text, this.bins);
      this.spectra.set(fact.id, s);
      return;
    }
    const s = eigenSpectrum(fact.text, this.bins);
    let bestId: string | undefined;
    let bestRes = this.adhesionThreshold;
    for (const [cid, cl] of this.clusters) {
      const r = resonance(s, cl.centroid);
      if (r >= bestRes) {
        bestRes = r;
        bestId = cid;
      }
    }
    this.spectra.set(fact.id, s);
    this.knownIds.add(fact.id);
    if (bestId !== undefined) {
      // Burgers 黏附：不写 base（去重），仅并入簇。
      const cl = this.clusters.get(bestId)!;
      cl.members.push(fact.id);
      cl.centroid = ResonantFieldMath.avgSpectrum(cl.centroid, s);
      return;
    }
    // 新簇：写入 base 并登记质心。
    this.base.remember(fact);
    const cid = `cl_${this.clusterSeq++}`;
    this.clusters.set(cid, { repId: fact.id, centroid: s, members: [fact.id], abstract: false });
  }

  // ── 共振寻址（燧-3） ──

  /**
   * 发射频谱探针：对全部已知事实按共振度降序取 top-k（同频即显、异频即散）。
   * @param probe 频率域探针谱。
   * @param k 返回条数上限（≤0 返回空数组）。
   * @returns 共振度降序的命中数组（事实 + 共振度）。
   */
  public resonate(probe: Spectrum, k: number): readonly ResonantHit[] {
    if (k <= 0) return [];
    const hits: ResonantHit[] = [];
    for (const [id, s] of this.spectra) {
      const f = this.base.get(id);
      if (f === undefined) continue;
      hits.push({ fact: f, score: resonance(s, probe) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  /**
   * 便捷共振寻址：把自然语言查询映射为频谱探针后转发 {@link resonate}。
   * @param query 自然语言查询文本。
   * @param k 返回条数上限。
   * @returns 共振度降序的命中数组。
   */
  public resonateByText(query: string, k: number): readonly ResonantHit[] {
    return this.resonate(eigenSpectrum(query, this.bins), k);
  }

  // ── 纤维召回（宇宙网） ──

  /**
   * 沿共振纤维（簇）召回：取与探针共振度最高的簇，按成员顺序返回其事实（至多 k 条）。
   * @param probe 频率域探针谱。
   * @param k 返回条数上限（≤0 返回空数组）。
   * @returns 最共振簇的成员事实数组（已从 base 取回完整事实）。
   */
  public fiber(probe: Spectrum, k: number): readonly MemoryFact[] {
    if (k <= 0) return [];
    let bestId: string | undefined;
    let bestRes = -1;
    for (const [cid, cl] of this.clusters) {
      const r = resonance(probe, cl.centroid);
      if (r > bestRes) {
        bestRes = r;
        bestId = cid;
      }
    }
    if (bestId === undefined) return [];
    const cl = this.clusters.get(bestId)!;
    const out: MemoryFact[] = [];
    for (const m of cl.members) {
      const f = this.base.get(m);
      if (f !== undefined) {
        out.push(f);
        if (out.length >= k) break;
      }
    }
    return out;
  }

  // ── RG 粗粒化坍缩 ──

  /**
   * RG 粗粒化坍缩：簇数超 Bekenstein 容量界时，反复把最小簇并入与其共振度最高的簇——
   * 删除两侧代表事实、改写一条 `topic='__web_abstract__'` 抽象代表（删二写一，落盘委托 base）。
   * @returns 坍缩报告：剩余节点（簇）数、本次坍缩次数、簇间纤维数。
   */
  public consolidate(): WebConsolidationReport {
    let collapsed = 0;
    while (this.clusters.size > this.bekensteinCap) {
      let smallId: string | undefined;
      let smallSize = Infinity;
      for (const [cid, cl] of this.clusters) {
        if (cl.members.length < smallSize) {
          smallSize = cl.members.length;
          smallId = cid;
        }
      }
      if (smallId === undefined) break;
      const small = this.clusters.get(smallId)!;
      let largeId: string | undefined;
      let largeRes = -1;
      for (const [cid, cl] of this.clusters) {
        if (cid === smallId) continue;
        const r = resonance(small.centroid, cl.centroid);
        if (r > largeRes) {
          largeRes = r;
          largeId = cid;
        }
      }
      if (largeId === undefined) break;
      const large = this.clusters.get(largeId)!;
      // 删 small + large 各自代表事实，写一条抽象代表（删二写一，存储不膨胀）。
      for (const m of small.members) {
        this.base.delete(m);
        this.knownIds.delete(m);
        this.spectra.delete(m);
      }
      this.base.delete(large.repId);
      this.knownIds.delete(large.repId);
      this.spectra.delete(large.repId);
      const abstractText =
        `${small.members.length} 簇: ${small.members.join(',')} / ${large.repId}`.slice(0, 240);
      const repId = `web_abstract_${largeId}_${collapsed}`;
      this.base.remember({
        id: repId,
        text: abstractText,
        topic: '__web_abstract__',
        importance: 3,
        createdAt: new Date().toISOString(),
        sessionId: 'resonant-field',
        source: 'consolidated',
      });
      large.repId = repId;
      large.centroid = ResonantFieldMath.avgSpectrum(small.centroid, large.centroid);
      large.abstract = true;
      large.members.push(...small.members);
      this.clusters.delete(smallId);
      collapsed++;
    }
    return { nodes: this.clusters.size, collapsed, fibers: this.computeFibers() };
  }

  /** 统计当前纤维边数：两两簇质心共振≥边阈值即计一条。
   * @returns 满足阈值的簇对（纤维边）总数。
   */
  private computeFibers(): number {
    const ids = [...this.clusters.keys()];
    let fibers = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = this.clusters.get(ids[i]!)!;
        const b = this.clusters.get(ids[j]!)!;
        if (resonance(a.centroid, b.centroid) >= this.edgeThreshold) fibers++;
      }
    }
    return fibers;
  }

  // ── 调谐（autoRun） ──

  /**
   * 调谐：从 base 重新播种全部频谱与簇索引（重启恢复），返回事实数与簇数（守恒自检）。
   * @returns facts=base 事实总数，clusters=重建后的簇数。
   */
  public tune(): { readonly facts: number; readonly clusters: number } {
    this.seed();
    return { facts: this.base.all().length, clusters: this.clusters.size };
  }

  // ── LongTermMemoryPort 委托 ──

  /**
   * 共振召回 + 时间衰减重排：把查询映射成频谱探针取共振 top 候选，
   * 再按「共振度 × 时间衰减」重排，失效事实丢弃。
   *
   * @param query 自然语言查询
   * @param k 取回条数
   * @returns 重排后的事实序列（衰减得分降序）
   */
  public recall(query: string, k: number): readonly MemoryFact[] {
    const hits = this.resonateByText(query, this.base.all().length);
    const items: ScoredFact[] = hits.map((h) => ({ fact: h.fact, score: h.score }));
    return rankWithDecay(items, this.clock(), this.halfLifeDays, k);
  }
  /** 全部事实（委托 base，供导出/调试）。
   * @returns base 中的全部事实列表。
   */
  public all(): readonly MemoryFact[] {
    return this.base.all();
  }
  /** 当前事实总数（委托 base）。 */
  public get count(): number {
    return this.base.count;
  }
  /** 按 id 取出事实（委托 base）；缺失返回 undefined。
   * @param id 事实 id。
   * @returns 对应事实；不存在时为 undefined。
   */
  public get(id: string): MemoryFact | undefined {
    return this.base.get(id);
  }
  /** 更新事实（委托 base），成功后同步刷新其频谱索引；返回是否更新成功。
   * @param id 要更新的事实 id。
   * @param patch 增量补丁（文本/重要性/主题等字段可选）。
   * @returns 是否更新成功（id 不存在为 false）。
   */
  public update(id: string, patch: MemoryFactPatch): boolean {
    const ok = this.base.update(id, patch);
    if (ok) {
      const f = this.base.get(id);
      if (f !== undefined) this.spectra.set(id, eigenSpectrum(f.text, this.bins));
    }
    return ok;
  }
  /**
   * 删除事实（委托 base）：成功时同步移除本地频谱索引与已知 id，保持场与落盘一致。
   * @param id 事实 ID。
   * @returns 是否删除成功（base 中不存在为 false）。
   */
  public delete(id: string): boolean {
    const ok = this.base.delete(id);
    if (ok) {
      this.knownIds.delete(id);
      this.spectra.delete(id);
    }
    return ok;
  }
}
