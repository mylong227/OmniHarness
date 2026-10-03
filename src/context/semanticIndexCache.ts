/**
 * 语义索引缓存（SemanticIndexCache）——把语料嵌入为向量索引并按配置键缓存。
 *
 * 设计要点：
 *  - 单一职责：负责「如何从语料构建一个 SemanticIndex」及其缓存复用；不含检索融合逻辑。
 *  - 文档装配与建索引同源：符号项、文件文档（buildFileDocTexts）、分块项（buildChunkItems）
 *    都从同一个 corpus 派生，避免「建索引」与「查询期文档」两份逻辑漂移。
 *  - **缓存键必须含配置**（chunkRecall / fullFileDoc / docMode）：索引内容随这些开关而变，
 *    若键不含它们，同进程内先后以不同开关调用会命中对方构建的索引——静默脏读（有单测回归）。
 *  - 存 Promise 以便并发请求复用同一次构建；构建失败缓存 null，下次重新尝试（仍 fail-closed）。
 */

import type { EmbeddingPort } from '../ports/model/embedding.js';
import type { IndexedCorpus } from './contextEngine.js';
import { SemanticIndex, type RecallItem } from './semanticIndex.js';
import { EmbeddingContentCache, type EmbeddingCacheStats } from './embeddingContentCache.js';
import { CachedEmbeddingPort } from './cachedEmbeddingPort.js';
import type { RecallKnobs } from './recallKnobs.js';
import { ArrayAt } from '../util/arrayAt.js';
import { log } from '../util/logger.js';

/** 全文文件文档最大字符数（约 8K token 内，留余量；ALiBi 可外推但质量在训练窗口内最佳）。 */
const FULL_FILE_DOC_MAX_CHARS = 8000;
/** 文件语义文档在 'snip' 模式下取正文的字符数上限（历史表示）。 */
const FILE_DOC_SNIPPET_CHARS = 600;
/** 单文件语义文档最多并入的符号名/签名个数（防止超长文件文档膨胀）。 */
const FILE_DOC_MAX_SYMBOLS = 60;
/** 分块语义召回时，单个符号函数体切片的行数上限。 */
export const CHUNK_BODY_MAX_LINES = 80;

export class SemanticIndexCache {
  /** 命中率上报回调（可缺省；缺省即不统计，行为与接入前完全一致）。 */
  private readonly onSample?: ((hit: boolean) => void) | undefined;
  /** 命中次数（观测用）。 */
  private hits = 0;
  /** 未命中次数（观测用）。 */
  private misses = 0;

  /**
   * @param onSample 命中率上报回调：每次查询判定后调用（命中=true）。
   */
  public constructor(onSample?: (hit: boolean) => void) {
    this.onSample = onSample;
  }

  /**
   * 语义索引缓存：按「配置键」缓存已构建的 SemanticIndex。
   * 存 Promise 以便并发请求复用同一次构建（构建期需 embed 全部符号/文件，较重）。
   * 构建失败存 null，下次请求重新尝试（仍 fail-closed 回退 BM25）。
   */
  private readonly cache = new Map<string, Promise<SemanticIndex | null>>();

  /**
   * 语料身份表（`IndexedCorpus` 实例 → 单调 id）。
   *
   * 存在理由（2026-09-26 审计 R3）：缓存键原先只有 `<chunk|rep>|<root>`，**不含语料身份**。
   * 而 TTL 到期重建语料时是**新对象**，旧语义索引不会失效 ⇒ 索引里的 `sym:<i>` / `file:<rel>`
   * 会被拿去新语料里解析：轻则静默丢弃，重则把**别的文件**顶上来。用 WeakMap 记身份既让新语料
   * 天然拿新键（不再脏读），又不阻止旧语料被回收。
   */
  private readonly corpusIds = new WeakMap<IndexedCorpus, number>();

  /** 下一个语料身份号（单调递增）。 */
  private nextCorpusId = 1;

  /**
   * 嵌入**内容**缓存（跨语料版本复用向量，2026-10-03 修 `PROJECT_BOARD` §3.2）：
   * 语料实例变化后索引对象仍按身份重建（审计 R3 的正确性要求），但每个文本的向量按内容复用
   * ⇒ 只改一两个文件时，不必整仓重新嵌入。详见 `EmbeddingContentCache`。
   */
  private readonly embeddingVectors = new EmbeddingContentCache();

  /** 内层端口 → 内容复用装饰器（按端口实例隔离，理由见 `cachedPortFor`）。 */
  private readonly cachedPorts = new WeakMap<EmbeddingPort, CachedEmbeddingPort>();

  /** 缓存条目上限（超出即淘汰最早插入的一条；键含语料身份，故旧语料条目不会命中）。 */
  private static readonly MAX_ENTRIES = 16;

  /**
   * 取（复用缓存或构建）语义索引。
   * @param root workspace 根路径（参与缓存键）。
   * @param corpus 已索引语料。
   * @param embedding 嵌入端口（模型缺失/离线会抛错，由调用方 fail-closed）。
   * @param knobs 已解析旋钮（决定索引内容与缓存键）。
   * @returns 语义索引。
   * @throws 当构建失败（嵌入异常等）时抛出，调用方据此回落纯 BM25。
   */
  public async get(
    root: string,
    corpus: IndexedCorpus,
    embedding: EmbeddingPort,
    knobs: RecallKnobs,
  ): Promise<SemanticIndex> {
    const key = this.cacheKey(root, knobs, corpus);
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      const idx = await existing;
      if (idx !== null) {
        this.sample(true);
        return idx;
      }
      // 上次构建失败：落空，重新尝试（计为未命中——本次确实要重新构建）。
    }
    this.sample(false);
    const promise = this.build(corpus, embedding, knobs);
    this.cache.set(key, promise);
    this.evictIfNeeded();
    const built = await promise;
    if (built === null) {
      throw new Error('semantic index build failed');
    }
    return built;
  }

  /**
   * 分块语义召回：把每个符号的**函数体**切成独立 chunk（带符号名/签名 + 代码体窗口），
   * 作为额外语义召回路。每个 chunk 的 id 用 `chunk:<i>`（i 为 corpus.symbols 下标），
   * 召回后由 `corpus.symbols[i].file` 映射回文件——复用与「符号→文件融合」完全相同的映射机制。
   *
   * body 窗口 = 从本符号声明行到同文件下一个符号声明行（或最多 CHUNK_BODY_MAX_LINES 行），
   * 截到末尾符号则用固定窗口。纯函数、无第三方依赖、可单测。
   * @param corpus 已索引语料。
   * @returns 分块召回项（含函数体文本）。
   */
  public buildChunkItems(corpus: IndexedCorpus): RecallItem[] {
    const byFile = new Map<string, number[]>();
    for (let i = 0; i < corpus.symbols.length; i++) {
      const f = ArrayAt.at(corpus.symbols, i).file;
      const arr = byFile.get(f);
      if (arr === undefined) {
        byFile.set(f, [i]);
      } else {
        arr.push(i);
      }
    }
    const items: RecallItem[] = [];
    for (let i = 0; i < corpus.symbols.length; i++) {
      const s = ArrayAt.at(corpus.symbols, i);
      const text = corpus.fileText.get(s.file);
      if (text === undefined) {
        continue;
      }
      const lines = text.split('\n');
      const arr = byFile.get(s.file);
      const pos = arr === undefined ? -1 : arr.indexOf(i);
      const start = Math.max(0, s.line - 1);
      let end: number;
      if (pos >= 0 && pos + 1 < arr!.length) {
        const next = ArrayAt.at(corpus.symbols, arr![pos + 1]!);
        end = Math.max(start, next.line - 1);
      } else {
        end = Math.min(lines.length, start + CHUNK_BODY_MAX_LINES);
      }
      let slice = lines.slice(start, end);
      if (slice.length > CHUNK_BODY_MAX_LINES) {
        slice = slice.slice(0, CHUNK_BODY_MAX_LINES);
      }
      const body = slice.join('\n');
      items.push({
        id: `chunk:${i}`,
        text: `${s.file}\n${s.name} ${s.kind} ${s.signature}\n${body}`,
      });
    }
    return items;
  }

  /**
   * 失效缓存。
   * @param root 指定则只失效该 root 下的全部配置变体；缺省清空全部。
   
 * @returns 无返回值。
*/
  public clear(root?: string): void {
    if (root === undefined) {
      this.cache.clear();
      // 嵌入内容缓存按**内容**（不含 root）索引，无法按 root 切分 ⇒ 只在全量清空时一并清掉。
      // 这样「清空全部」语义完整；按 root 清空时残留的内容向量仍只服务于**同一文本**的复用
      // （同一文本在任何 root 下的向量相同），不构成脏读。
      this.embeddingVectors.clear();
      return;
    }
    // 缓存键形如 `<chunk|nochunk>|<rep>|<root>`，按 root 失效须清掉该 root 下全部变体。
    // 注意 root 前有**两个**分隔符（配置位 + 表示位），故必须按**最后一个** `|` 切分：
    // 原实现用 `indexOf('|')` 只切掉配置位，比较串变成 `snip600|<root>`，与 root 永不相等
    // ⇒ 整个方法实为空操作（语义索引在语料失效/清空后仍被命中，静默脏读）。
    for (const k of [...this.cache.keys()]) {
      if (k.slice(k.lastIndexOf('|') + 1) === root) {
        this.cache.delete(k);
      }
    }
  }

  /**
   * 构建（不缓存的内部实现）。
   * @param corpus 已索引语料。
   * @param embedding 嵌入端口。
   * @param knobs 已解析旋钮。
   * @returns 语义索引；构建失败返回 null（由 get 转换为抛错）。
   */
  private async build(
    corpus: IndexedCorpus,
    embedding: EmbeddingPort,
    knobs: RecallKnobs,
  ): Promise<SemanticIndex | null> {
    try {
      const items: RecallItem[] = [];
      corpus.symbols.forEach((s, i) => {
        items.push({ id: `sym:${i}`, text: `${s.name} ${s.kind} ${s.signature} ${s.file}` });
      });
      // 文件语义文档 = 路径 + 该文件符号名 + 正文片段。
      // 关键教训：TS 文件前 N 字符几乎全是 import / license 注释，光靠正文片段做向量≈噪声，
      // 语义路因此在真实代码库上几乎没有召回能力（实测天花板仅 44.6% vs BM25 43.2%）。
      // 符号名才是「这个文件是干什么的」的最强表征，且 corpus 里现成就有，零额外成本。
      const fileDocs = this.buildFileDocTexts(corpus, knobs);
      for (const [fid, ftext] of fileDocs) {
        items.push({ id: fid, text: ftext });
      }
      // 分块语义召回：把每个符号的函数体切成 chunk（带符号名/签名），弥补文件文档只取
      // 前 600 字符的表示缺陷。chunk 项与符号项并行，互补不互斥（同 knobs.chunkRecall 控制）。
      if (knobs.chunkRecall) {
        for (const c of this.buildChunkItems(corpus)) {
          items.push(c);
        }
      }
      const port = this.cachedPortFor(embedding);
      const idx = new SemanticIndex(port);
      // 嵌入内容缓存按代际清扫：构建**成功**后丢弃本次没碰过的向量（失败不清扫，
      // 否则会把上一代可用向量一并丢掉，下次重试又要从零嵌入）。见 `EmbeddingContentCache`。
      this.embeddingVectors.beginGeneration();
      await idx.build(items);
      this.embeddingVectors.endGeneration();
      // 构建后落盘（2026-10-03 修）：带落盘缓存的端口（`DiskCachedEmbeddingAdapter`）默认每
      // `flushThreshold`（512）条才自动落盘，**尾部不落**；其类文档称「装配层在关停时调用
      // flush()」，而仓内此前**没有任何调用点** ⇒ 每次构建最多 511 条向量静默丢失，重启后重付。
      // 这里是「向量刚产生」的时刻，比关停更早且必然发生，故在此落盘。
      // fail-soft：端口未实现则跳过；实现抛错/失败只告警（缓存问题绝不升级为功能故障）。
      try {
        port.flush?.();
      } catch (error) {
        log.warn('semanticIndex.flush.failed', {
          root: corpus.root,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return idx;
    } catch {
      return null;
    }
  }

  /**
   * 取（或首次构造）某嵌入端口的**内容复用装饰器**。
   *
   * 为什么按端口实例缓存装饰器：不同端口的维度/前缀策略可能不同，共用一份内容缓存会把
   * A 模型的向量喂给 B 模型。按实例隔离后，「同一端口跨语料版本」这一生产形态才是复用面。
   * 用 `WeakMap` 而非 `Map`：端口被替换后可被回收，不构成泄漏。
   * @param embedding 内层嵌入端口。
   * @returns 装饰后的端口。
   */
  private cachedPortFor(embedding: EmbeddingPort): CachedEmbeddingPort {
    const existing = this.cachedPorts.get(embedding);
    if (existing !== undefined) {
      return existing;
    }
    const wrapped = new CachedEmbeddingPort(embedding, this.embeddingVectors);
    this.cachedPorts.set(embedding, wrapped);
    return wrapped;
  }

  /**
   * 构建每个文件的语义文档文本（与 build 建索引时同源）。
   * 抽成单一来源：语义索引构建与查询期文档构造都用它，避免双份逻辑漂移。
   * @param corpus 已索引语料。
   * @param knobs 已解析旋钮（docMode / fullFileDoc 决定文档形态）。
   * @returns `file:<rel>` → 文档文本。
   */
  private buildFileDocTexts(corpus: IndexedCorpus, knobs: RecallKnobs): Map<string, string> {
    const symbolsByFile = new Map<string, string[]>();
    const sigsByFile = new Map<string, string[]>();
    for (const s of corpus.symbols) {
      const arr = symbolsByFile.get(s.file);
      if (arr === undefined) {
        symbolsByFile.set(s.file, [s.name]);
        sigsByFile.set(s.file, [s.signature]);
      } else if (arr.length < FILE_DOC_MAX_SYMBOLS) {
        arr.push(s.name);
        sigsByFile.get(s.file)!.push(s.signature);
      }
    }
    const docs = new Map<string, string>();
    for (const f of corpus.files) {
      const text = corpus.fileText.get(f.rel) ?? '';
      let body: string;
      if (knobs.fullFileDoc) {
        // 实验 1（Late Chunking）：长上下文代码模型（如 jina 8K）编码整文件，单向量含全文语义。
        body =
          text.length > FULL_FILE_DOC_MAX_CHARS ? text.slice(0, FULL_FILE_DOC_MAX_CHARS) : text;
      } else if (knobs.docMode === 'id') {
        // 实验 1b（浓缩身份）：rel + 符号名 + 签名，丢弃原始代码噪声。
        const names = (symbolsByFile.get(f.rel) ?? []).join(' ');
        const sigs = (sigsByFile.get(f.rel) ?? []).join(' ');
        body = `${names}\n${sigs}`;
      } else {
        const snippet =
          text.length > FILE_DOC_SNIPPET_CHARS ? text.slice(0, FILE_DOC_SNIPPET_CHARS) : text;
        const names = (symbolsByFile.get(f.rel) ?? []).join(' ');
        body = `${names}\n${snippet}`;
      }
      docs.set(`file:${f.rel}`, `${f.rel}\n${body}`);
    }
    return docs;
  }

  /**
   * 语义索引缓存键：必须带上 chunkRecall / fullFileDoc / docMode 三个开关。
   * @param root workspace 根路径。
   * @param knobs 已解析旋钮。
   * @returns 唯一键。
   */
  private cacheKey(root: string, knobs: RecallKnobs, corpus: IndexedCorpus): string {
    const rep = knobs.fullFileDoc ? 'fulldoc' : knobs.docMode === 'id' ? 'id' : 'snip600';
    // `root` 仍放**最后一位**：`invalidate(root)` 按最后一个 `|` 切分，格式不能变。
    return `${knobs.chunkRecall ? 'chunk' : 'nochunk'}|${rep}|c${String(this.corpusIdOf(corpus))}|${root}`;
  }

  /**
   * 取（或分配）语料身份号。
   * @param corpus 已索引语料。
   * @returns 该语料的稳定身份号（同实例恒同号）。
   */
  private corpusIdOf(corpus: IndexedCorpus): number {
    const existing = this.corpusIds.get(corpus);
    if (existing !== undefined) {
      return existing;
    }
    const id = this.nextCorpusId;
    this.nextCorpusId += 1;
    this.corpusIds.set(corpus, id);
    return id;
  }

  /**
   * 嵌入内容缓存的统计（观测/测试用）。
   * @returns `{ hits, misses, entries }`：复用命中数、真实嵌入数、常驻向量条目数。
   */
  public embeddingCacheStats(): EmbeddingCacheStats {
    return this.embeddingVectors.stats();
  }

  /**
   * 命中率观测（与 `onSample` 同源的自有计数，供单测与诊断直接读取）。
   * @returns `{ hits, misses, entries }`：命中数、未命中数、当前条目数。
   */
  public stats(): { readonly hits: number; readonly misses: number; readonly entries: number } {
    return { hits: this.hits, misses: this.misses, entries: this.cache.size };
  }

  /** 上报一次命中判定（同时累加自有计数）。
   * @param hit 是否命中。
   * @returns 无返回值。
   */
  private sample(hit: boolean): void {
    if (hit) {
      this.hits += 1;
    } else {
      this.misses += 1;
    }
    this.onSample?.(hit);
  }

  /**
   * 缓存条目有界：超出上限即淘汰最早插入的一条。
   * @returns 无返回值。
   */
  private evictIfNeeded(): void {
    while (this.cache.size > SemanticIndexCache.MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.cache.delete(oldest.value);
    }
  }
}
