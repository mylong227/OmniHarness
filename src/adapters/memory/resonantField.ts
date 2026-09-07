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
 */
import type {
  LongTermMemoryPort,
  MemoryFact,
  MemoryFactPatch,
} from '../../ports/longTermMemory.js';
import type { ResonantHit, ResonantMemoryPort } from '../../ports/resonantMemory.js';
import type { CosmicWebPort, WebConsolidationReport } from '../../ports/cosmicWeb.js';
import type { ResonantFieldOptions, ResonantFieldPort } from '../../ports/resonantField.js';
import { eigenSpectrum, resonance, type Spectrum } from '../../util/eigenspectrum.js';

/** 共振簇：质心 + 成员事实 id（含是否已被抽象代表取代）。 */
interface Cluster {
  repId: string;
  centroid: Spectrum;
  members: string[];
  abstract: boolean;
}

function avgSpectrum(a: Spectrum, b: Spectrum): Spectrum {
  const n = Math.max(a.values.length, b.values.length);
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const va = a.values[i] ?? 0;
    const vb = b.values[i] ?? 0;
    out[i] = (va + vb) / 2;
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return { bins: n, values: out.map((v) => v / norm) };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 共振场统一引擎。
 */
export class ResonantFieldEngine
  implements ResonantFieldPort, ResonantMemoryPort, CosmicWebPort, LongTermMemoryPort
{
  readonly name = 'resonant-field';

  /** 单一频谱索引（消除双重频谱）。 */
  private readonly spectra = new Map<string, Spectrum>();
  /** 共振簇（拓扑，进程内）。 */
  private readonly clusters = new Map<string, Cluster>();
  private readonly knownIds = new Set<string>();
  private clusterSeq = 0;

  private readonly adhesionThreshold: number;
  private readonly bekensteinCap: number;
  private readonly edgeThreshold: number;
  private readonly bins: number;

  constructor(
    private readonly base: LongTermMemoryPort,
    opts: ResonantFieldOptions = {},
  ) {
    this.adhesionThreshold = clamp(opts.adhesionThreshold ?? 0.75, 0, 1);
    this.bekensteinCap = Math.max(1, Math.floor(opts.bekensteinCap ?? 64));
    this.edgeThreshold = clamp(opts.edgeThreshold ?? 0.4, 0, 1);
    this.bins = opts.bins ?? 257;
    this.seed();
  }

  /** 从 base 重新播种谱与簇（重启恢复；abstract 事实恢复为簇质心）。 */
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

  remember(fact: MemoryFact): void {
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
      cl.centroid = avgSpectrum(cl.centroid, s);
      return;
    }
    // 新簇：写入 base 并登记质心。
    this.base.remember(fact);
    const cid = `cl_${this.clusterSeq++}`;
    this.clusters.set(cid, { repId: fact.id, centroid: s, members: [fact.id], abstract: false });
  }

  // ── 共振寻址（燧-3） ──

  resonate(probe: Spectrum, k: number): readonly ResonantHit[] {
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

  resonateByText(query: string, k: number): readonly ResonantHit[] {
    return this.resonate(eigenSpectrum(query, this.bins), k);
  }

  // ── 纤维召回（宇宙网） ──

  fiber(probe: Spectrum, k: number): readonly MemoryFact[] {
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

  consolidate(): WebConsolidationReport {
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
      large.centroid = avgSpectrum(small.centroid, large.centroid);
      large.abstract = true;
      large.members.push(...small.members);
      this.clusters.delete(smallId);
      collapsed++;
    }
    return { nodes: this.clusters.size, collapsed, fibers: this.computeFibers() };
  }

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

  tune(): { readonly facts: number; readonly clusters: number } {
    this.seed();
    return { facts: this.base.all().length, clusters: this.clusters.size };
  }

  // ── LongTermMemoryPort 委托 ──

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
    if (ok) {
      const f = this.base.get(id);
      if (f !== undefined) this.spectra.set(id, eigenSpectrum(f.text, this.bins));
    }
    return ok;
  }
  delete(id: string): boolean {
    const ok = this.base.delete(id);
    if (ok) {
      this.knownIds.delete(id);
      this.spectra.delete(id);
    }
    return ok;
  }
}
