import type {
  LongTermMemoryPort,
  MemoryFact,
  MemoryFactPatch,
} from '../../ports/longTermMemory.js';
import type { CosmicWebPort, WebConsolidationReport } from '../../ports/cosmicWeb.js';
import { eigenSpectrum, resonance, type Spectrum } from '../../util/eigenspectrum.js';

/** 宇宙网节点：代表一条核心知识/技能，持共振质心与成员事实 id。 */
interface WebNode {
  repId: string;
  centroid: Spectrum;
  members: string[];
  text: string;
}

/** 宇宙网记忆引擎选项（全有保守默认；fail-closed 边界夹紧）。 */
export interface CosmicWebOptions {
  /** 黏附半径（共振度阈值）：新事实与节点共振≥此值则不可逆黏附去重。默认 0.75。 */
  readonly adhesionThreshold?: number;
  /** Bekenstein 容量界：节点数硬上限，超限触发 RG 坍缩。默认 64。 */
  readonly bekensteinCap?: number;
  /** 纤维边阈值：节点间共振≥此值记为一条纤维。默认 0.4。 */
  readonly edgeThreshold?: number;
  /** 本征谱分箱（须与共振引擎一致）。默认 257。 */
  readonly bins?: number;
}

function avgSpectrum(a: Spectrum, b: Spectrum): Spectrum {
  const n = Math.max(a.values.length, b.values.length);
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const va = a.values[i] ?? 0;
    const vb = b.values[i] ?? 0;
    out[i] = (va + vb) / 2;
  }
  // 重新归一化。
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return { bins: n, values: out.map((v) => v / norm) };
}

/**
 * 宇宙网记忆引擎（Cosmic-Web Memory Engine，I-P1-2）。
 *
 * 包装任意 `LongTermMemoryPort`，使其自组织成宇宙网：
 * - **Burgers 黏附巩固**：`remember` 时新事实若与某节点共振≥黏附半径，则不可逆黏附进该
 *   节点（去重强化，不写新条目）；否则新建节点。
 * - **RG 粗粒化坍缩**：`consolidate` 在节点数超 Bekenstein 容量界时，反复把最小簇与最近大簇
 *   合并为一条抽象代表事实（删多写一），存储不膨胀、结构收敛到吸引子。
 * - **纤维召回**：`fiber` 发射频谱探针，返回共振簇成员。
 *
 * 同时实现 `LongTermMemoryPort`：作为长期记忆端口的零侵入 drop-in 替换（委托标准读写给
 * base，仅改写 `remember` 为黏附巩固 + 增 `consolidate`/`fiber`）。复用燧-3 频率域共振度
 * 构建边权。零运行时依赖。
 */
export class CosmicWebMemoryEngine implements CosmicWebPort, LongTermMemoryPort {
  readonly name = 'cosmic-web-memory';
  private readonly memory: LongTermMemoryPort;
  private readonly adhesionThreshold: number;
  private readonly bekensteinCap: number;
  private readonly edgeThreshold: number;
  private readonly bins: number;
  private readonly nodes = new Map<string, WebNode>();

  constructor(memory: LongTermMemoryPort, opts: CosmicWebOptions = {}) {
    this.memory = memory;
    this.adhesionThreshold = clamp(opts.adhesionThreshold ?? 0.75, 0, 1);
    this.bekensteinCap = Math.max(1, Math.floor(opts.bekensteinCap ?? 64));
    this.edgeThreshold = clamp(opts.edgeThreshold ?? 0.4, 0, 1);
    this.bins = opts.bins ?? 257;
    // 从既有记忆播种节点（每个既有事实一个初始节点）。
    for (const f of memory.all()) {
      if (f.topic === '__web_abstract__') continue;
      this.nodes.set(f.id, {
        repId: f.id,
        centroid: eigenSpectrum(f.text, this.bins),
        members: [f.id],
        text: f.text,
      });
    }
  }

  remember(fact: MemoryFact): void {
    const s = eigenSpectrum(fact.text, this.bins);
    let bestId: string | undefined;
    let bestRes = this.adhesionThreshold; // 必须严格 ≥ 阈值才黏附
    for (const [id, node] of this.nodes) {
      const r = resonance(s, node.centroid);
      if (r >= bestRes) {
        bestRes = r;
        bestId = id;
      }
    }
    if (bestId !== undefined) {
      // Burgers 黏附：不可逆写入只在收敛点发生 → 去重强化，不新建条目。
      const node = this.nodes.get(bestId)!;
      node.centroid = avgSpectrum(node.centroid, s);
      node.members.push(fact.id);
      return;
    }
    // 新节点：写入事实并登记质心。
    this.memory.remember(fact);
    this.nodes.set(fact.id, { repId: fact.id, centroid: s, members: [fact.id], text: fact.text });
  }

  consolidate(): WebConsolidationReport {
    let collapsed = 0;
    while (this.nodes.size > this.bekensteinCap) {
      // 最小簇。
      let smallId: string | undefined;
      let smallSize = Infinity;
      for (const [id, node] of this.nodes) {
        if (node.members.length < smallSize) {
          smallSize = node.members.length;
          smallId = id;
        }
      }
      if (smallId === undefined) break;
      const small = this.nodes.get(smallId)!;
      // 最近大簇（最大共振）。
      let largeId: string | undefined;
      let largeRes = -1;
      for (const [id, node] of this.nodes) {
        if (id === smallId) continue;
        const r = resonance(small.centroid, node.centroid);
        if (r > largeRes) {
          largeRes = r;
          largeId = id;
        }
      }
      if (largeId === undefined) break; // 无他节点可合并
      const large = this.nodes.get(largeId)!;
      // RG 坍缩：删 small + large 各自代表事实，写一条抽象代表（删二写一，存储不膨胀）。
      for (const m of small.members) this.memory.delete(m);
      this.memory.delete(large.repId);
      const abstractText = `${small.text} / ${large.text}`.slice(0, 240);
      const repId = `web_abstract_${largeId}_${collapsed}`;
      this.memory.remember({
        id: repId,
        text: abstractText,
        topic: '__web_abstract__',
        importance: 3,
        createdAt: new Date().toISOString(),
        sessionId: 'cosmic-web',
        source: 'consolidated',
      });
      large.repId = repId;
      large.centroid = avgSpectrum(small.centroid, large.centroid);
      large.text = abstractText;
      large.members.push(...small.members);
      this.nodes.delete(smallId);
      collapsed++;
    }
    return { nodes: this.nodes.size, collapsed, fibers: this.computeFibers() };
  }

  fiber(probe: Spectrum, k: number): readonly MemoryFact[] {
    if (k <= 0) return [];
    let bestId: string | undefined;
    let bestRes = -1;
    for (const [id, node] of this.nodes) {
      const r = resonance(probe, node.centroid);
      if (r > bestRes) {
        bestRes = r;
        bestId = id;
      }
    }
    if (bestId === undefined) return [];
    const node = this.nodes.get(bestId)!;
    const out: MemoryFact[] = [];
    for (const m of node.members) {
      const f = this.memory.get(m);
      if (f !== undefined) out.push(f);
      if (out.length >= k) break;
    }
    return out;
  }

  private computeFibers(): number {
    const ids = [...this.nodes.keys()];
    let fibers = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = this.nodes.get(ids[i]!)!;
        const b = this.nodes.get(ids[j]!)!;
        if (resonance(a.centroid, b.centroid) >= this.edgeThreshold) fibers++;
      }
    }
    return fibers;
  }

  // ── LongTermMemoryPort 委托（drop-in 替换） ──
  recall(query: string, k: number): readonly MemoryFact[] {
    return this.memory.recall(query, k);
  }
  all(): readonly MemoryFact[] {
    return this.memory.all();
  }
  get count(): number {
    return this.memory.count;
  }
  get(id: string): MemoryFact | undefined {
    return this.memory.get(id);
  }
  update(id: string, patch: MemoryFactPatch): boolean {
    const ok = this.memory.update(id, patch);
    if (ok) {
      const node = this.nodes.get(id);
      if (node !== undefined && patch.importance !== undefined) {
        // 轻量同步：仅更新文本/质心若提供。
        if (patch.text !== undefined) {
          node.text = patch.text;
          node.centroid = eigenSpectrum(patch.text, this.bins);
        }
      }
    }
    return ok;
  }
  delete(id: string): boolean {
    const ok = this.memory.delete(id);
    if (ok) this.nodes.delete(id);
    return ok;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
