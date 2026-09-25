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
} from '../../ports/memory/longTermMemory.js';
import { Bm25Index } from '../../search/bm25Index.js';
import { TimeDecay, type ScoredFact } from './timeDecay.js';
import type { TextCodec } from './aesGcmTextCodec.js';
import { ArrayAt } from '../../util/arrayAt.js';

/**
 * @beta
 * 文件持久化长期记忆（#S28）：JSONL 落盘于 `<workspace>/.omniharness/longterm/memory.jsonl`，
 * 零依赖、Node 20、Windows 可用。进程重启后自动重载；召回复用零依赖 BM25 内核。
 *
 * 写入采用 append-only（每条事实一行），崩溃安全；损坏行启动时跳过不致命。
 * 索引按插入顺序维护，命中 `id` 即事实数组下标，与 BM25 文档下标对齐。
 *
 * 加密（#4.4 Vault 集成）：可注入 `codec`（默认恒等），每条事实行独立编码。
 * 因每条文本独立加密（随机 iv），append-only 不变量仍然成立，无需整文件重加密。
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

  /**
   * @param path JSONL 存储文件路径。
   * @param codec 每行文本编解码器（默认恒等；可注入 AES-GCM 加密编解码）。
   * @param halfLifeDays 时间衰减半衰期（天），召回重排用，默认 90。
   * @param clock 时钟函数（毫秒时间戳），测试可注入固定时钟，默认 Date.now。
   */
  public constructor(
    private readonly path: string,
    private readonly codec: TextCodec = { encode: (t) => t, decode: (t) => t },
    private readonly halfLifeDays: number = 90,
    private readonly clock: () => number = Date.now,
  ) {
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
  }

  /** 写入一条持久事实（内存追加 + 落盘）。
   * @param fact 待写入的持久事实。
   * @returns 无返回值。
   */
  public remember(fact: MemoryFact): void {
    this.facts.push(fact);
    this.dirty = true;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, this.codec.encode(JSON.stringify(fact)) + '\n', 'utf8');
    } catch {
      // 落盘失败不致命：进程内内存态仍可用。
    }
  }

  /**
   * 按自然语言召回 top-k 事实（BM25 + 时间衰减）。
   * 先取全部 BM25 命中，再按「相关性 × 时间衰减」重排，落后者被自然压低；
   * 失效（expiresAt 到点）的事实直接丢弃。
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
    const hits = (this.bm25 as Bm25Index).search(Bm25Index.tokenize(trimmed), this.facts.length);
    const items: ScoredFact[] = [];
    for (const hit of hits) {
      const fact = this.facts[hit.id];
      if (fact !== undefined) {
        items.push({ fact, score: hit.score });
      }
    }
    return TimeDecay.rankWithDecay(items, this.clock(), this.halfLifeDays, k);
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
    this.facts[idx] = {
      ...current,
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.topic !== undefined ? { topic: patch.topic } : {}),
      ...(patch.importance !== undefined
        ? { importance: Math.min(5, Math.max(1, Math.round(patch.importance))) }
        : {}),
    };
    this.persistAll();
    return true;
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
    this.persistAll();
    return true;
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
    } catch {
      // 重写失败不致命：内存态仍反映最新，下次写入再尝试落盘。
    }
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
