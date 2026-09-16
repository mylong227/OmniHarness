/**
 * 评测用「带磁盘缓存的嵌入端口」（CachedEmbeddingPort）。
 *
 * 为什么需要：真实 ONNX 嵌入是本仓库最贵的评测成本——本语料 483 文件 / 7787 符号，
 * 单次语义索引构建要编码约 8000 条文本；而 `SemanticIndexCache` 的缓存是**进程内**的，
 * 每换一组旋钮（如 `docMode:'id'` 改变文件文档文本）就要重来一遍，实测单次实验 >30min，
 * 使「多假说对照」在时间上不可行。
 *
 * 做法：按**文本粒度**缓存向量（而不是按索引整体）。键 = 模型 + 角色 + 归一化 + 文本哈希。
 * 于是换旋钮时只有**真正变化的文本**（如 483 条文件文档）需要重编码，符号文本（7787 条）直接复用
 * —— 增量成本降一个数量级。
 *
 * 存储：`<prefix>.keys`（每行一个键）+ `<prefix>.f32`（Float32 向量顺序拼接）。
 * 选二进制而非 JSON：8270×384 维用 JSON 约 60MB，用 Float32 仅 12.7MB，且读快。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 包装任意 EmbeddingPort，为其增加按文本粒度的磁盘缓存。 */
export class CachedEmbeddingPort {
  /**
   * @param inner 真实嵌入端口（须有 dim 与 embed）。
   * @param prefix 缓存文件前缀（会生成 `<prefix>.keys` 与 `<prefix>.f32`）。
   * @param batchSize 单次调用内层的批大小（控制内存峰值）。
   */
  constructor(inner, prefix, batchSize = 64) {
    this.inner = inner;
    this.prefix = prefix;
    this.batchSize = batchSize;
    this.dim = inner.dim;
    /** 已缓存文本的键（与 data 的行一一对应）。 */
    this.keys = [];
    /** 键 → 行号。 */
    this.index = new Map();
    /** 已用行数。 */
    this.count = 0;
    /** 倍增缓冲（避免逐条 concat 的 O(n²) 拷贝）。 */
    this.data = new Float32Array(0);
    this.hits = 0;
    this.misses = 0;
    this.load();
  }

  /** 从磁盘加载已有缓存（不存在则空起步）。 */
  load() {
    const kf = `${this.prefix}.keys`;
    const vf = `${this.prefix}.f32`;
    if (!existsSync(kf) || !existsSync(vf)) return;
    this.keys = readFileSync(kf, 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    this.count = this.keys.length;
    this.keys.forEach((k, i) => this.index.set(k, i));
    const raw = readFileSync(vf);
    const usable = Math.min(this.count, Math.floor(raw.byteLength / (this.dim * 4)));
    // 复制一份到独立 ArrayBuffer，避免与 Node 内部分配共享生命周期。
    this.data = new Float32Array(usable * this.dim);
    for (let i = 0; i < usable * this.dim; i++) {
      this.data[i] = raw.readFloatLE(i * 4);
    }
    this.count = usable;
  }

  /** 确保缓冲至少能容纳 need 行（按倍增扩容）。 */
  ensure(need) {
    if (need <= this.data.length / this.dim) return;
    let cap = Math.max(this.data.length / this.dim, 1024);
    while (cap < need) cap *= 2;
    const next = new Float32Array(cap * this.dim);
    next.set(this.data.subarray(0, this.count * this.dim));
    this.data = next;
  }

  /** 把当前内存缓存落盘（keys 与向量一体）。 */
  flush() {
    mkdirSync(dirname(this.prefix), { recursive: true });
    writeFileSync(`${this.prefix}.keys`, this.keys.join('\n') + (this.keys.length ? '\n' : ''));
    const view = Buffer.from(this.data.buffer, this.data.byteOffset, this.count * this.dim * 4);
    writeFileSync(`${this.prefix}.f32`, view);
  }

  /** 取第 i 个缓存向量。 */
  vecAt(i) {
    return Array.from(this.data.subarray(i * this.dim, (i + 1) * this.dim));
  }

  /** 追加一条向量到内存缓存。 */
  append(key, vec) {
    this.ensure(this.count + 1);
    const base = this.count * this.dim;
    for (let i = 0; i < this.dim; i++) this.data[base + i] = vec[i];
    this.index.set(key, this.count);
    this.keys.push(key);
    this.count++;
  }

  /**
   * 批量嵌入（命中缓存直接返回，未命中回源并按批补齐，随后落盘）。
   * @param texts 待嵌入文本。
   * @param opts 嵌入选项（role / normalize 参与缓存键）。
   * @returns 与输入等长的向量列表。
   */
  async embed(texts, opts) {
    const role = opts?.role ?? 'document';
    const normalize = opts?.normalize !== false;
    const modelId = this.inner.modelId ?? 'unknown';
    const keys = texts.map((t) =>
      createHash('sha1').update(`${modelId}|${role}|${normalize}|${t}`).digest('hex'),
    );

    const out = new Array(texts.length);
    const missIdx = [];
    for (let i = 0; i < texts.length; i++) {
      const hit = this.index.get(keys[i]);
      if (hit === undefined) {
        missIdx.push(i);
      } else {
        out[i] = this.vecAt(hit);
        this.hits++;
      }
    }
    for (let s = 0; s < missIdx.length; s += this.batchSize) {
      const chunk = missIdx.slice(s, s + this.batchSize);
      const vecs = await this.inner.embed(
        chunk.map((i) => texts[i]),
        opts,
      );
      for (let j = 0; j < chunk.length; j++) {
        const i = chunk[j];
        const v = vecs[j];
        if (v === undefined) continue;
        this.append(keys[i], v);
        out[i] = v;
        this.misses++;
      }
    }
    this.flush();
    return out;
  }
}
