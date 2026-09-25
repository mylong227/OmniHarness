import type {
  LongTermMemoryPort,
  MemoryFact,
  MemoryFactPatch,
} from '../../ports/memory/longTermMemory.js';
import type { ResonantHit, ResonantMemoryPort } from '../../ports/memory/resonantMemory.js';
import { eigenSpectrum, resonance, type Spectrum } from '../../util/eigenspectrum.js';
import { rankWithDecay, type ScoredFact } from './timeDecay.js';

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
 *
 * @deprecated 与 U1 统一记忆基板同算法重复（DEFICIENCY_AUDIT §3.2 定案，2026-09-25 起标记）：
 * 按弃用流程将在**下一个次版本移除**，届时请迁移到 U1 基板路径；存量
 * `resonance.enabled` 装配在本版本内继续可用（行为不变）。
 */
export class ResonantMemoryEngine implements ResonantMemoryPort, LongTermMemoryPort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'resonant-memory'）。 */
  public readonly name = 'resonant-memory';

  /** 事实 id → 预计算本征频谱的缓存（检索打分的频率域索引）。 */
  private readonly spectra = new Map<string, Spectrum>();
  /** 脏标记：base 事实发生写入/更新/删除后置真，下次检索前惰性重建全部本征谱。 */
  private dirty = true;

  /**
   * @param base 被包装的底层长期记忆端口（标准读写与其计数均委托给它）。
   * @param bins 本征谱分箱数（频谱维度），默认 257。
   * @param halfLifeDays 时间衰减半衰期（天），用于召回重排，默认 90。
   * @param clock 时钟函数（毫秒时间戳），测试可注入固定时钟，默认 Date.now。
   */
  public constructor(
    private readonly base: LongTermMemoryPort,
    private readonly bins = 257,
    private readonly halfLifeDays: number = 90,
    private readonly clock: () => number = Date.now,
  ) {}

  /** 重建本征谱缓存：清空后为 base 全部事实重算频谱并清除脏标记。
   * @returns 无返回值。
   */
  private rebuild(): void {
    this.spectra.clear();
    for (const f of this.base.all()) {
      this.spectra.set(f.id, eigenSpectrum(f.text, this.bins));
    }
    this.dirty = false;
  }

  /** 以频谱探针做共振寻址，返回按共振度降序的 top-k 命中（脏时惰性重建本征谱；k≤0 返回空）。
   * @param probe 频谱探针（可为纯频率签名，不必是自然语言）。
   * @param k 最多返回的命中条数。
   * @returns 按「事实与探针的共振度」降序的命中列表（共振度为 0-1 余弦相似度）。
   */
  public resonate(probe: Spectrum, k: number): readonly ResonantHit[] {
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

  /** 将查询文本映射为频谱探针后调用共振寻址，返回 top-k 命中。
   * @param query 自然语言查询文本（先经本征谱映射）。
   * @param k 最多返回的命中条数。
   * @returns 按共振度降序的命中列表。
   */
  public resonateByText(query: string, k: number): readonly ResonantHit[] {
    return this.resonate(eigenSpectrum(query, this.bins), k);
  }

  // ── LongTermMemoryPort 委托 + 共振召回（drop-in 替换） ──

  /** 写入并标记脏：下次共振前重建本征谱。
   * @param fact 待写入的记忆事实。
   * @returns 无返回值。
   */
  public remember(fact: MemoryFact): void {
    this.base.remember(fact);
    this.dirty = true;
  }

  /**
   * 共振召回 + 时间衰减重排：取共振 top 候选后按「共振度 × 时间衰减」重排，失效事实丢弃。
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

  /** 返回全部事实（委托 base 标准读）。
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

  /** 更新事实（委托 base），成功后标记脏以待下次重建本征谱；返回是否成功。
   * @param id 要更新的事实 id。
   * @param patch 增量补丁（文本/重要性/主题等字段可选）。
   * @returns 是否更新成功（id 不存在为 false）。
   */
  public update(id: string, patch: MemoryFactPatch): boolean {
    const ok = this.base.update(id, patch);
    if (ok) this.dirty = true;
    return ok;
  }

  /** 删除事实（委托 base），成功后标记脏；返回是否删除成功。
   * @param id 要删除的事实 id。
   * @returns 是否删除成功（id 不存在为 false）。
   */
  public delete(id: string): boolean {
    const ok = this.base.delete(id);
    if (ok) this.dirty = true;
    return ok;
  }

  /**
   * 燧-3 调谐（autoRun 用）：强制重算全部本征谱，返回事实数与簇数（守恒自检：
   * 二者应相等，否则说明重建与 base 状态不一致）。供 SparkController 任务末统一调谐。
   * @returns 事实数与簇数的守恒自检报告。
   */
  public tune(): { readonly facts: number; readonly clusters: number } {
    this.rebuild();
    return { facts: this.base.all().length, clusters: this.spectra.size };
  }
}
