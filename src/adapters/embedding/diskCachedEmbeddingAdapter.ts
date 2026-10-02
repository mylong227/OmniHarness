/**
 * 磁盘缓存嵌入适配器（DiskCachedEmbeddingAdapter）——给任意 {@link EmbeddingPort} 加一层
 * **按文本粒度**的持久向量缓存，使语义索引可以**跨进程复用**已编码的向量。
 *
 * ## 为什么必须有它（这是语义路的真实成本结构）
 *
 * `SemanticIndexCache` 的缓存是**进程内**的（`Map<string, Promise<SemanticIndex|null>>`）：
 * 进程一退，全部向量随之消失。而真实 ONNX 编码是本仓最贵的单项成本——本仓语料
 * （数百文件 / 上万符号）单次索引要编码上万条文本，冷启动在分钟级。
 * 于是「语义路开不开」在很多场景下实际取决于「你愿不愿意每次重启都重付一遍编码成本」，
 * 而不是取决于它有没有增益。**落盘把这一项从「每次进程生命周期付一遍」变成「每条文本付一次」。**
 *
 * ## 为什么缓存键落在文本粒度，而不是「整个索引一把」
 *
 * 索引内容随旋钮而变（`chunkRecall` / `fullFileDoc` / `docMode`）：
 * 换 `docMode` 会改变**文件文档**文本，但**符号文档**（上万条，占绝对多数）逐字不变。
 * 若按「索引整体」缓存，换一个旋钮就要重编码全部——这正是评测侧
 * （`evals/lib/embedding-cache.mjs`）当初做文本粒度缓存的原因（否则多假说对照在时间上不可行）。
 * 生产同理：旋钮一调就全量重编码是**结构上不可接受**的。故本适配器按
 * `模型 + 维度 + 角色 + 归一化 + 文本哈希` 缓存单个向量。
 *
 * ## 键里为什么必须有模型身份（否则是静默错答案）
 *
 * 换模型（如 minilm-384 → e5-large-1024）时向量空间完全不同。若键不含模型，
 * 旧向量会被当成新模型的向量返回——**不报错、维度可能还对得上**，得到的是看似正常的错误排序。
 * 故键含 `modelId`（端口未暴露时回落 `unknown:<dim>`）与 `dim`，二者任一变化即整体不命中。
 *
 * ## 落盘时机（不是「每次 embed 都写」）
 *
 * 高写入放大会把一次评测变成磁盘风暴。这里的纪律是：
 *  - 只有 **document** 角色的向量才使缓存变脏（`query` 文本每次都不同，落盘它们纯是浪费）；
 *  - 脏条目累计到 `flushThreshold` 才落盘一次，且**索引建完那一刻必然会到阈值之上**；
 *  - `flush()` 公开给装配层在关停时显式调用（`dispose()` 可挂到容器生命周期）。
 *
 * ## fail-closed 的边界（必须说清，防止被读成「缓存坏了就崩」）
 *
 * 缓存**只是加速层，不是正确性层**：读写失败一律降级为「照常调用内层端口」，
 * 绝不因为缓存不可写而让嵌入失败（那会把一个性能优化变成功能故障）。
 * 唯一例外是**首次构造时**目录不可建——那时只记一条 warn 并转为纯内存模式。
 *
 * @maturity L2 — 结构同构（键值缓存 → 二进制向量表，与 `evals/lib/embedding-cache.mjs` 同一算法，
 *   该实现已在语义评测里长期使用）；且本类有本地单测覆盖命中/未命中/维度不匹配/不可写降级。
 * @maturityEvidence tests/unit/diskCachedEmbedding.test.ts
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Embedding, EmbeddingPort } from '../../ports/model/embedding.js';
import type { EmbedOptions } from '../../ports/model/embedding/embedOptions.js';
import type { EmbeddingPreloadOutcome } from '../../ports/model/embedding/embeddingPreloadOutcome.js';
import { log } from '../../util/logger.js';

/** 构造选项。 */
export interface DiskCachedEmbeddingOptions {
  /** 内层嵌入端口（真实编码器）。 */
  readonly inner: EmbeddingPort;
  /**
   * 缓存文件前缀：会生成 `<prefix>.keys`（每行一个键）与 `<prefix>.f32`（Float32 向量顺序拼接）。
   * 为 `undefined` 时**不落盘**，退化为纯内存缓存（装配层无法解析出可写目录时的诚实降级）。
   */
  readonly cacheDir?: string | undefined;
  /** 缓存文件基名（缺省 `embedding`），允许多模型在同一目录下并存。 */
  readonly cacheName?: string | undefined;
  /** 单次调用内层的批大小（控制内存峰值；缺省 64）。 */
  readonly batchSize?: number | undefined;
  /** 脏条目累计到多少条才自动落盘（缺省 512；越小越安全、越大越省 IO）。 */
  readonly flushThreshold?: number | undefined;
}

/** 缓存键与向量的查看统计（观测用）。 */
export interface DiskCachedEmbeddingStats {
  /** 命中条数。 */
  readonly hits: number;
  /** 未命中（回源编码）条数。 */
  readonly misses: number;
  /** 已缓存条数。 */
  readonly entries: number;
  /** 自上次落盘以来新增的脏条目数。 */
  readonly pending: number;
  /** 是否处于落盘模式（false = 纯内存）。 */
  readonly persistent: boolean;
}

/**
 * 磁盘缓存嵌入适配器：包装任意 {@link EmbeddingPort}，按文本粒度持久化向量。
 */
export class DiskCachedEmbeddingAdapter implements EmbeddingPort {
  /** 输出向量维度（透传内层，用于缓存文件的行布局与维度校验）。 */
  public readonly dim: number;
  /** 内层真实嵌入端口。 */
  private readonly inner: EmbeddingPort;
  /** 缓存文件键路径（`<prefix>.keys`）；纯内存模式为 undefined。 */
  private readonly keysPath: string | undefined;
  /** 缓存文件向量路径（`<prefix>.f32`）；纯内存模式为 undefined。 */
  private readonly vectorsPath: string | undefined;
  /** 单次调用内层的批大小。 */
  private readonly batchSize: number;
  /** 自动落盘的脏条目阈值。 */
  private readonly flushThreshold: number;

  /** 已缓存文本的键（与 `data` 的行一一对应）。 */
  private readonly keys: string[] = [];
  /** 键 → 行号（O(1) 命中判定）。 */
  private readonly index = new Map<string, number>();
  /** 已用行数（≤ `data.length / dim`）。 */
  private count = 0;
  /** 倍增缓冲：避免逐条拼接造成 O(n²) 拷贝。 */
  private data = new Float32Array(0);
  /** 自上次落盘以来的脏条目数。 */
  private pending = 0;
  /** 命中缓存的条数（观测用）。 */
  private hits = 0;
  /** 未命中、回源编码的条数（观测用）。 */
  private misses = 0;

  /**
   * @param options 内层端口、缓存位置与批量/落盘策略。
   */
  public constructor(options: DiskCachedEmbeddingOptions) {
    this.inner = options.inner;
    this.dim = options.inner.dim;
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? 64));
    this.flushThreshold = Math.max(1, Math.floor(options.flushThreshold ?? 512));
    if (options.cacheDir === undefined || options.cacheDir.trim() === '') {
      this.keysPath = undefined;
      this.vectorsPath = undefined;
      return;
    }
    const prefix = `${options.cacheDir}/${options.cacheName ?? 'embedding'}`;
    this.keysPath = `${prefix}.keys`;
    this.vectorsPath = `${prefix}.f32`;
    this.load();
  }

  /** 解析出的模型身份（键的组成部分，键不含它会导致跨模型静默错答案）。 */
  private get modelId(): string {
    // 内层适配器普遍暴露 `modelId`（诊断用）。端口契约没有该字段，故用结构收窄而非改端口。
    const withId = this.inner as { readonly modelId?: unknown };
    const id = withId.modelId;
    return typeof id === 'string' && id !== '' ? id : `unknown-${String(this.dim)}`;
  }

  /**
   * 从磁盘加载既有缓存；文件不存在或不可读即空起步（不抛错）。
   *
   * 维度不匹配的处理：`<prefix>.f32` 若与当前 `dim` 不符（换模型 / 缓存被截断），
   * 只采用**能整除**的前缀行数，多余尾部丢弃——既不崩，也不产生错位的向量。
   * @returns 无返回值。
   */
  private load(): void {
    const keysPath = this.keysPath;
    const vectorsPath = this.vectorsPath;
    if (keysPath === undefined || vectorsPath === undefined) {
      return;
    }
    try {
      if (!existsSync(keysPath) || !existsSync(vectorsPath)) {
        return;
      }
      const loaded = readFileSync(keysPath, 'utf8')
        .split('\n')
        .filter((line) => line !== '');
      loaded.forEach((key, i) => this.index.set(key, i));
      const raw = readFileSync(vectorsPath);
      const rows = Math.floor(raw.byteLength / (this.dim * 4));
      const usable = Math.min(loaded.length, rows);
      this.data = new Float32Array(usable * this.dim);
      for (let i = 0; i < usable * this.dim; i++) {
        this.data[i] = raw.readFloatLE(i * 4);
      }
      // 截断的行要从键表里去掉：键在而向量不在 ⇒ 该键会被判为命中却读出半行垃圾。
      this.keys.length = 0;
      this.index.clear();
      for (let i = 0; i < usable; i++) {
        const key = loaded[i];
        if (key === undefined) {
          continue;
        }
        this.index.set(key, i);
        this.keys.push(key);
      }
      this.count = usable;
    } catch (error) {
      log.warn('diskCachedEmbedding.loadFailed（缓存不可读，按空缓存起步）', {
        keysPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 取第 i 个缓存向量（复制为普通数组，避免调用方改到内部缓冲）。
   * @param i 行号。
   * @returns 该行的向量。
   */
  private vectorAt(i: number): Embedding {
    const out: number[] = [];
    for (let k = 0; k < this.dim; k++) {
      out.push(this.data[i * this.dim + k] ?? 0);
    }
    return out;
  }

  /** 确保缓冲至少能容纳 `need` 行（倍增扩容）。
   * @param need 目标行数。
   * @returns 无返回值。
   */
  private ensureCapacity(need: number): void {
    const capacity = this.data.length / this.dim;
    if (need <= capacity) {
      return;
    }
    let next = Math.max(capacity, 1024);
    while (next < need) {
      next *= 2;
    }
    const grown = new Float32Array(next * this.dim);
    grown.set(this.data.subarray(0, this.count * this.dim));
    this.data = grown;
  }

  /** 追加一条向量到内存缓存。
   * @param key 缓存键。
   * @param vector 向量（长度不足时补 0）。
   * @returns 无返回值。
   */
  private append(key: string, vector: Embedding): void {
    this.ensureCapacity(this.count + 1);
    const base = this.count * this.dim;
    for (let i = 0; i < this.dim; i++) {
      this.data[base + i] = vector[i] ?? 0;
    }
    this.index.set(key, this.count);
    this.keys.push(key);
    this.count += 1;
  }

  /**
   * 计算某文本在给定选项下的缓存键。
   * @param text 文本。
   * @param role 角色（document / query）。
   * @param normalize 是否 L2 归一化。
   * @returns 十六进制缓存键。
   */
  private keyOf(text: string, role: string, normalize: boolean): string {
    return createHash('sha1')
      .update(`${this.modelId}|${String(this.dim)}|${role}|${String(normalize)}|${text}`)
      .digest('hex');
  }

  /**
   * 批量嵌入：命中缓存直接返回，未命中回源编码，并按需落盘。
   * @param texts 待嵌入文本。
   * @param opts 嵌入选项（角色 / 归一化参与缓存键；批大小透传）。
   * @returns 与输入等长的向量列表。
   */
  public async embed(texts: readonly string[], opts?: EmbedOptions): Promise<readonly Embedding[]> {
    if (texts.length === 0) {
      return [];
    }
    const role = opts?.role ?? 'document';
    const normalize = opts?.normalize !== false;
    const keys = texts.map((text) => this.keyOf(text, role, normalize));

    const out: (Embedding | undefined)[] = new Array<Embedding | undefined>(texts.length);
    const missing: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      const key = keys[i];
      const at = key === undefined ? undefined : this.index.get(key);
      if (at === undefined) {
        missing.push(i);
      } else {
        out[i] = this.vectorAt(at);
        this.hits += 1;
      }
    }

    for (let start = 0; start < missing.length; start += this.batchSize) {
      const chunk = missing.slice(start, start + this.batchSize);
      const vectors = await this.inner.embed(
        chunk.map((i) => texts[i] ?? ''),
        opts,
      );
      for (let j = 0; j < chunk.length; j++) {
        const i = chunk[j];
        const vector = vectors[j];
        const key = i === undefined ? undefined : keys[i];
        if (i === undefined || vector === undefined || key === undefined) {
          continue;
        }
        this.append(key, vector);
        out[i] = vector;
        this.misses += 1;
        // 只有 document 才计入落盘压力：query 文本几乎每次不同，落盘它们纯是磁盘浪费。
        if (role === 'document') {
          this.pending += 1;
        }
      }
    }

    if (role === 'document' && this.pending >= this.flushThreshold) {
      this.flush();
    }

    // 回源失败的槽位（内层返回短数组）补零向量：契约要求与输入等长，
    // 返回 undefined 会迫使每个调用方都写一遍收窄（且语义索引会静默漏条）。
    return out.map((v) => v ?? new Array<number>(this.dim).fill(0));
  }

  /**
   * 把内存缓存落盘（幂等；无缓存路径或非脏时为空操作）。
   *
   * **失败不抛**：缓存是加速层，磁盘满 / 权限不足绝不能让嵌入调用失败或拖垮主流程。
   * @returns 是否真的写入（false = 无路径 / 无脏条目 / 写入失败）。
   */
  public flush(): boolean {
    const keysPath = this.keysPath;
    const vectorsPath = this.vectorsPath;
    if (keysPath === undefined || vectorsPath === undefined || this.pending === 0) {
      return false;
    }
    try {
      mkdirSync(dirname(keysPath), { recursive: true });
      writeFileSync(keysPath, this.keys.join('\n') + (this.keys.length > 0 ? '\n' : ''));
      const view = Buffer.from(this.data.buffer, this.data.byteOffset, this.count * this.dim * 4);
      writeFileSync(vectorsPath, view);
      this.pending = 0;
      return true;
    } catch (error) {
      log.warn('diskCachedEmbedding.flushFailed（缓存不可写，继续纯内存运行）', {
        keysPath,
        error: error instanceof Error ? error.message : String(error),
      });
      // 不清零 pending：下次仍会尝试，避免一次瞬时失败让本进程此后永不落盘。
      return false;
    }
  }

  /** 缓存命中统计（观测出口）。
   * @returns 命中/未命中/条目数/脏条目数/是否落盘模式。
   */
  public stats(): DiskCachedEmbeddingStats {
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.count,
      pending: this.pending,
      persistent: this.keysPath !== undefined,
    };
  }

  /**
   * 预热透传：内层提供 `preload` 时原样转发（缓存层不改变「把冷启动成本前置」的语义）。
   * @returns 内层预热结果；内层未实现时回 `{ok:true, ms:0, built:false}`（无成本可预热）。
   */
  public async preload(): Promise<EmbeddingPreloadOutcome> {
    if (this.inner.preload === undefined) {
      return { ok: true, ms: 0, built: false };
    }
    return this.inner.preload();
  }
}
