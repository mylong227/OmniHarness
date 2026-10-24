import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type {
  LongTermMemoryPort,
  MemoryFact,
  MemoryFactPatch,
} from '../../ports/memory/longTermMemory.ts';
import { Bm25Index } from '../../search/bm25Index.ts';
import { TimeDecay, type ScoredFact } from './timeDecay.ts';
import type { TextCodec } from './aesGcmTextCodec.ts';
import {
  TemporalFactGraph,
  type TemporalConsolidateOptions,
  type TemporalConsolidationReport,
  type TemporalFactHit,
} from './temporalFactGraph.ts';
import { ArrayAt } from '../../util/arrayAt.ts';
import { log } from '../../util/logger.ts';

/**
 * @beta
 * 文件持久化长期记忆（#S28）：JSONL 落盘于 `<workspace>/.omniharness/longterm/memory.jsonl`，
 * 无第三方依赖、Node 20、Windows 可用。进程重启后自动重载；召回复用无第三方依赖 BM25 内核。
 *
 * 写入采用 append-only（每条事实一行），崩溃安全；损坏行启动时跳过不致命。
 * 索引按插入顺序维护，命中 `id` 即事实数组下标，与 BM25 文档下标对齐。
 *
 * 加密（#4.4 Vault 集成）：可注入 `codec`（默认恒等），每条事实行独立编码。
 * 因每条文本独立加密（随机 iv），append-only 不变量仍然成立，无需整文件重加密。
 *
 * 时间图（P2-1，**默认开启**）：内部维护 {@link TemporalFactGraph}，把可解析事实投影成
 * `subject-predicate-object` 事实卡；`recall` 同时取 BM25 命中与图命中并按 `factId` 合并
 * （`max(BM25, 图分)`，确定性；无图命中时分数与顺序与旧实现逐位一致），随后仍走原 `TimeDecay`。
 * 事实卡随 JSONL 持久化**重建**（构造时从 facts 重放，不额外落盘图）。抽取是**规则**而非语义解析，
 * 解析不出就不建边——边界见 `temporalFactGraph.ts` 的类注释。
 */
export class FileLongTermMemory implements LongTermMemoryPort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'file-longterm'）。 */
  public readonly name = 'file-longterm';

  /** 事实数组（插入序；数组下标即 BM25 文档 id）。 */
  private facts: MemoryFact[] = [];
  /** BM25 倒排索引（懒构建；脏时在下次召回前重建）。 */
  private bm25: Bm25Index | undefined;
  /** 脏标记：事实集变化（load/update/delete）后置真，触发索引重建。 */
  private dirty = false;
  /** 记忆时间图（默认启用；显式关闭时为 undefined，走纯 BM25 旧路径）。 */
  private readonly graph: TemporalFactGraph | undefined;

  /**
   * @param path JSONL 存储文件路径。
   * @param codec 每行文本编解码器（默认恒等；可注入 AES-GCM 加密编解码）。
   * @param halfLifeDays 时间衰减半衰期（天），召回重排用，默认 90。
   * @param clock 时钟函数（毫秒时间戳），测试可注入固定时钟，默认 Date.now。
   * @param untrustedPenalty 不可信来源事实的召回得分惩罚（0..1；默认 0.5，降低记忆投毒权重）。
   * @param temporalGraph 是否启用记忆时间图（P2-1，默认 true）；传 false 可完全回到纯 BM25 行为。
   */
  public constructor(
    private readonly path: string,
    private readonly codec: TextCodec = { encode: (t) => t, decode: (t) => t },
    private readonly halfLifeDays: number = 90,
    private readonly clock: () => number = Date.now,
    private readonly untrustedPenalty: number = 0.5,
    temporalGraph: boolean = true,
  ) {
    this.graph = temporalGraph ? new TemporalFactGraph() : undefined;
    this.load();
  }

  /** 从 JSONL 重载既有事实（进程重启后跨会话记忆恢复）。
   * @returns 无返回值。
   */
  private load(): void {
    if (!existsSync(this.path)) {
      return;
    }
    const raw = readFileSync(this.path, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      try {
        const decoded = this.codec.decode(trimmed);
        this.facts.push(JSON.parse(decoded) as MemoryFact);
      } catch {
        // 损坏行（或密文损坏）跳过，不阻断启动。
      }
    }
    this.dirty = true;
    // 图不单独落盘：进程重启后从 JSONL 读回的事实**重放**而来，保证派生索引与事实同源。
    this.graph?.rebuild(this.facts, this.clock());
  }

  /** 写入一条持久事实（内存追加 + 落盘）。
   * @param fact 待写入的持久事实。
   * @returns 无返回值。
   */
  public remember(fact: MemoryFact): void {
    this.facts.push(fact);
    this.dirty = true;
    this.graph?.ingest(fact, this.clock());
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, this.codec.encode(JSON.stringify(fact)) + '\n', 'utf8');
    } catch (error) {
      // 内存态保留（进程内仍可用），但**必须留痕**：旧实现静默吞掉，于是 remember() 照常返回、
      // 调用方以为事实已持久化，重启后却查无此条（2026-09-26 审计 S26）。
      this.reportPersistFailure('append', error);
    }
  }

  /**
   * 按自然语言召回 top-k 事实（BM25 + 时间图 + 时间衰减）。
   *
   * 候选合并：先取全部 BM25 命中；若启用时间图，再取图命中，按 `factId` 合并
   * （`max(BM25 分, 图分)`，确定性）。没有图命中的事实分数与旧实现**逐位相同**，
   * 因此既有排序不被扰动；随后统一走 `TimeDecay`（`expiresAt` 过滤 + 衰减 + untrusted 降权）。
   *
   * 边界：图命中只来自**有效**边（`validTo`/`expiresAt` 到点的边不参与图召回），但图
   * **不会**反过来删掉 BM25 命中——`validTo` 只影响图候选，事实自身的失效仍以 `expiresAt` 为准。
   *
   * @param query 自然语言查询
   * @param k 取回条数
   * @returns 重排后的事实序列（衰减得分降序）
   */
  public recall(query: string, k: number): readonly MemoryFact[] {
    const trimmed = query.trim();
    if (trimmed === '' || k <= 0 || this.facts.length === 0) {
      return [];
    }
    if (this.dirty || this.bm25 === undefined) {
      this.rebuild();
    }
    const nowMs = this.clock();
    const scores = new Map<string, number>();
    const hits = (this.bm25 as Bm25Index).search(Bm25Index.tokenize(trimmed), this.facts.length);
    for (const hit of hits) {
      const fact = this.facts[hit.id];
      if (fact !== undefined) {
        scores.set(fact.id, hit.score);
      }
    }
    if (this.graph !== undefined) {
      for (const hit of this.graph.recall(trimmed, nowMs)) {
        const bm25Score = scores.get(hit.factId);
        if (bm25Score === undefined || hit.score > bm25Score) {
          scores.set(hit.factId, hit.score);
        }
      }
    }
    // 按事实插入序构造候选：与 BM25 旧路径同分同序（BM25 旧命中序对同分也是插入序），排序稳定。
    const items: ScoredFact[] = [];
    for (const fact of this.facts) {
      const score = scores.get(fact.id);
      if (score !== undefined) {
        items.push({ fact, score });
      }
    }
    return TimeDecay.rankWithDecay(items, nowMs, this.halfLifeDays, k, this.untrustedPenalty);
  }

  /** 全部事实。
   * @returns 全部事实列表（插入序）。
   */
  public all(): readonly MemoryFact[] {
    return this.facts;
  }

  /** 事实总数。 */
  public get count(): number {
    return this.facts.length;
  }

  /** 按 ID 取单条事实。
   * @param id 事实 id。
   * @returns 对应事实；不存在时为 undefined。
   */
  public get(id: string): MemoryFact | undefined {
    return this.facts.find((fact) => fact.id === id);
  }

  /** 编辑一条事实（内存 + 整文件原子重写）。
   * @param id 要编辑的事实 id。
   * @param patch 增量补丁（文本/主题/重要性可选；重要性夹紧到 1-5）。
   * @returns 是否编辑成功（id 不存在为 false）。
   */
  public update(id: string, patch: MemoryFactPatch): boolean {
    const idx = this.facts.findIndex((fact) => fact.id === id);
    if (idx === -1) {
      return false;
    }
    const current = ArrayAt.at(this.facts, idx);
    const next: MemoryFact = {
      ...current,
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.topic !== undefined ? { topic: patch.topic } : {}),
      ...(patch.importance !== undefined
        ? { importance: Math.min(5, Math.max(1, Math.round(patch.importance))) }
        : {}),
      // 显式 `expiresAt: undefined` 表示清除失效时间 ⇒ 必须用 `in` 而不是 `!== undefined`。
      ...('expiresAt' in patch ? { expiresAt: patch.expiresAt } : {}),
    };
    this.facts[idx] = next;
    if (patch.text !== undefined || 'expiresAt' in patch) {
      // 文本/失效时间影响图：按事实自身时间重放该卡（幂等；不复活它曾取代的旧边，见类注释边界）。
      this.graph?.ingest(next, this.clock());
    }
    this.persistAll();
    return true;
  }

  /** 批量编辑（内存 + **一次**整文件原子重写）。
   *
   * 为什么需要它（2026-09-26 审计 S13）：退火器一步会更新上千条事实的重要性，若走 `update`
   * 就是上千次「整文件重写 + 重加密 + writeFileSync + renameSync」—— O(n²) 的同步 IO 把事件
   * 循环整段钉住。批量入口把落盘次数收敛为 1。
   * @param patches 待应用的补丁列表（未命中的 id 跳过）。
   * @returns 实际被修改的条数。
   */
  public updateMany(
    patches: readonly { readonly id: string; readonly patch: MemoryFactPatch }[],
  ): number {
    let changed = 0;
    const regraph: MemoryFact[] = [];
    for (const entry of patches) {
      const idx = this.facts.findIndex((fact) => fact.id === entry.id);
      if (idx === -1) {
        continue;
      }
      const current = ArrayAt.at(this.facts, idx);
      const next: MemoryFact = {
        ...current,
        ...(entry.patch.text !== undefined ? { text: entry.patch.text } : {}),
        ...(entry.patch.topic !== undefined ? { topic: entry.patch.topic } : {}),
        ...(entry.patch.importance !== undefined
          ? { importance: Math.min(5, Math.max(1, Math.round(entry.patch.importance))) }
          : {}),
        ...('expiresAt' in entry.patch ? { expiresAt: entry.patch.expiresAt } : {}),
      };
      this.facts[idx] = next;
      if (entry.patch.text !== undefined || 'expiresAt' in entry.patch) {
        regraph.push(next);
      }
      changed += 1;
    }
    if (changed > 0) {
      // 只有文本/失效时间影响图；纯重要性/主题补丁（退火器热路径）不重算图。
      for (const fact of regraph) {
        this.graph?.ingest(fact, this.clock());
      }
      this.persistAll();
    }
    return changed;
  }

  /** 删除一条事实（内存 + 整文件原子重写）。
   * @param id 要删除的事实 id。
   * @returns 是否删除成功（id 不存在为 false）。
   */
  public delete(id: string): boolean {
    const idx = this.facts.findIndex((fact) => fact.id === id);
    if (idx === -1) {
      return false;
    }
    this.facts.splice(idx, 1);
    this.graph?.remove(id);
    this.persistAll();
    return true;
  }

  /**
   * 巩固记忆时间图（P2-1）：合并同 s+p+o 重复边、关闭过期边并返回统计。
   *
   * **不删除任何事实**（`facts`/JSONL 原样保留；图只是派生索引）；显式关闭图时返回全零统计。
   * 详细语义见 {@link TemporalFactGraph.consolidate}。
   * @param nowMs 当前时刻（毫秒；缺省取注入时钟）。
   * @param options 巩固选项（默认剪除已关闭边）。
   * @returns 巩固统计。
   */
  public consolidate(
    nowMs: number = this.clock(),
    options: TemporalConsolidateOptions = {},
  ): TemporalConsolidationReport {
    if (this.graph === undefined) {
      return { before: 0, after: 0, merged: 0, expired: 0, pruned: 0, active: 0 };
    }
    return this.graph.consolidate(nowMs, options);
  }

  /**
   * 时间图召回信号（内部能力，供外层记忆装饰器合并到自己的召回里）。
   *
   * 为什么不进 `LongTermMemoryPort`：图是 FileLongTermMemory 的实现细节，端口保持窄契约；
   * 生产默认的 `ResonantFieldEngine.recall` 会探测本可选方法并按 `factId` 取 `max` 合并。
   * @param query 自然语言查询。
   * @param nowMs 当前时刻（毫秒）。
   * @returns 图命中列表（图关闭时为空数组）。
   */
  public temporalRecall(query: string, nowMs: number): readonly TemporalFactHit[] {
    return this.graph?.recall(query.trim(), nowMs) ?? [];
  }

  /**
   * 记忆时间图句柄（诊断 / 管理 UI / 判据用）。
   * @returns 时间图实例；构造时显式关闭则为 undefined。
   */
  public get factGraph(): TemporalFactGraph | undefined {
    return this.graph;
  }

  /** 用全量事实原子重写文件（temp + rename，避免半写损坏）。
   * @returns 无返回值。
   */
  private persistAll(): void {
    this.dirty = true;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = this.path + '.tmp';
      const lines =
        this.facts.map((fact) => this.codec.encode(JSON.stringify(fact))).join('\n') + '\n';
      writeFileSync(tmp, lines, 'utf8');
      renameSync(tmp, this.path);
    } catch (error) {
      // 同上：内存态照常反映最新，但落盘失败必须可观测（否则「改了但没存」无人知晓）。
      this.reportPersistFailure('rewrite', error);
    }
  }

  /**
   * 上报一次持久化失败（结构化 warn，带路径与失败模式）。
   *
   * 刻意**不抛出**：长期记忆是 best-effort 增强，落盘失败不该中断主流程（改记忆的回合仍应完成）。
   * 但静默吞掉会让「调用方以为已持久化」成为事实——留痕是这个取舍成立的前提。
   * @param stage 失败阶段（`append` 单条追加 / `rewrite` 全量重写）。
   * @param error 原始错误。
   * @returns 无返回值。
   */
  private reportPersistFailure(stage: 'append' | 'rewrite', error: unknown): void {
    log.warn('memory.longterm.persist_failed', {
      stage,
      path: this.path,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /** 用全量事实重建 BM25 索引。
   * @returns 无返回值。
   */
  private rebuild(): void {
    const next = new Bm25Index();
    next.addDocuments(this.facts.map((fact) => Bm25Index.tokenize(fact.text)));
    this.bm25 = next;
    this.dirty = false;
  }
}
