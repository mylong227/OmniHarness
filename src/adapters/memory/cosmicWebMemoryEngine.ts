/**
 * @maturity L0 — 邻接连通在；Kuramoto 同步动力学未实现
 * @maturityEvidence tests/unit/cosmicWeb.test.ts
 */
import type {
  LongTermMemoryPort,
  MemoryFact,
  MemoryFactPatch,
} from '../../ports/memory/longTermMemory.js';
import type { CosmicWebPort, WebConsolidationReport } from '../../ports/memory/cosmicWeb.js';
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
  readonly adhesionThreshold?: number | undefined;
  /** Bekenstein 容量界：节点数硬上限，超限触发 RG 坍缩。默认 64。 */
  readonly bekensteinCap?: number | undefined;
  /** 纤维边阈值：节点间共振≥此值记为一条纤维。默认 0.4。 */
  readonly edgeThreshold?: number | undefined;
  /** 本征谱分箱（须与共振引擎一致）。默认 257。 */
  readonly bins?: number | undefined;
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
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'cosmic-web-memory'）。 */
  public readonly name = 'cosmic-web-memory';
  /** 被包装的底层长期记忆端口：标准读写全部委托给它。 */
  private readonly memory: LongTermMemoryPort;
  /** 黏附半径（共振度阈值）：≥此值的新事实并入既有节点而不新建条目。 */
  private readonly adhesionThreshold: number;
  /** Bekenstein 容量界：节点数硬上限，超过即触发 RG 粗粒化坍缩。 */
  private readonly bekensteinCap: number;
  /** 纤维边阈值：两节点质心共振≥此值时计为一条纤维边。 */
  private readonly edgeThreshold: number;
  /** 本征谱分箱数：文本 → 频率谱的维度，须与共振引擎一致。 */
  private readonly bins: number;
  /** 节点表：节点 id → 网络节点（代表事实、质心谱与成员事实 id 列表）。 */
  private readonly nodes = new Map<string, WebNode>();

  public constructor(memory: LongTermMemoryPort, opts: CosmicWebOptions = {}) {
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

  /** 写入事实：Burgers 黏附巩固——与某节点共振≥黏附阈值则不可逆并入该节点（去重、不写新条目），否则建新节点落盘。
   * @param fact 待写入的记忆事实。
   * @returns 无返回值。
   */
  public remember(fact: MemoryFact): void {
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

  /** RG 粗粒化坍缩：节点数超 Bekenstein 容量界时反复合并最小簇与最近大簇（删二写一），返回坍缩报告。
   * @returns 坍缩报告：剩余节点数、本次坍缩次数与纤维边数。
   */
  public consolidate(): WebConsolidationReport {
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

  /** 纤维召回：发射频谱探针，返回共振最强节点中最多 k 条成员事实（k≤0 返回空）。
   * @param probe 频谱探针（与节点质心同维度的 Spectrum）。
   * @param k 最多返回的成员事实条数。
   * @returns 共振最强节点的成员事实（按成员顺序，最多 k 条，已删除者跳过）。
   */
  public fiber(probe: Spectrum, k: number): readonly MemoryFact[] {
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

  /** 统计当前纤维边数：两两节点质心共振≥边阈值即计一条。
   * @returns 满足阈值的节点对（纤维边）总数。
   */
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
  /** 召回：委托底层记忆的标准 recall（共振重排由 base 负责）。
   * @param query 自然语言查询文本。
   * @param k 最多返回的事实条数。
   * @returns 与查询相关的记忆事实列表（排序与打分由 base 决定）。
   */
  public recall(query: string, k: number): readonly MemoryFact[] {
    return this.memory.recall(query, k);
  }
  /** 返回全部事实（委托 base 标准读）。
   * @returns 底层记忆中的全部事实列表。
   */
  public all(): readonly MemoryFact[] {
    return this.memory.all();
  }
  /** 当前事实总数（委托 base）。 */
  public get count(): number {
    return this.memory.count;
  }
  /** 按 id 取出事实（委托 base）；缺失返回 undefined。
   * @param id 事实 id。
   * @returns 对应事实；不存在时为 undefined。
   */
  public get(id: string): MemoryFact | undefined {
    return this.memory.get(id);
  }
  /** 更新事实（委托 base）；若 patch 提供新文本则同步刷新该节点质心（目录谱）。
   * @param id 要更新的事实 id。
   * @param patch 增量补丁（文本/重要性/主题等字段可选）。
   * @returns 是否更新成功（id 不存在为 false）。
   */
  public update(id: string, patch: MemoryFactPatch): boolean {
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
  /** 删除事实（委托 base），成功后清理对应节点；返回是否删除成功。
   * @param id 要删除的事实 id。
   * @returns 是否删除成功（id 不存在为 false）。
   */
  public delete(id: string): boolean {
    const ok = this.memory.delete(id);
    if (ok) this.nodes.delete(id);
    return ok;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
