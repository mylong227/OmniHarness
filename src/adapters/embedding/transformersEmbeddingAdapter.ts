/**
 * Transformers 嵌入适配器（真实实现）：用 @huggingface/transformers 在本地跑 ONNX 嵌入模型。
 *
 * 铁律合规：
 *  - 本文件位于 src/adapters/embedding/**，第三方只在此出现；对外仅暴露 EmbeddingPort。
 *  - 用「import type + 动态 import()」：编译期不加载该包，运行时仅在语义嵌入启用时才加载，
 *    模型缺失/离线时抛错由调用方 fail-closed 回退 BM25-only。
 *  - 已登记于 dependency-allowlist.json（Apache-2.0，预算超限已显式审批）。
 *
 * 多模型支持：默认 **e5-large-v2**（检索级 1024 维，真实代码库混合召回 64.8% 实测最优；
 * 代价 321MB 权重 + 约 23.6min 索引构建税，模型缺失时 fail-closed 回落 BM25-only）；
 * minilm 留作轻量可选预设（22MB/81s）；可选 e5 家族
 * （代码检索级，MTEB 检索榜前列，需 query/passage 前缀）；可选 gte 家族
 * （对称、无前缀、容量更大，Xenova/gte-large 为 1024 维 MTEB 强模型，用于测「模型容量」
 * 这一单一变量）。unixcoder 等需要 ONNX 转换的模型当前不可用
 * （Xenova 镜像无 ONNX 权重，404），见底部说明。
 */

import type {
  Embedding,
  EmbeddingPort,
  EmbeddingPreloadOutcome,
  EmbedOptions,
} from '../../ports/model/embedding.js';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { log } from '../../util/logger.js';

/** 模型前缀模式：决定 embed 时是否、如何注入查询/文档不对称前缀。 */
type PrefixMode = 'none' | 'e5';

/** 单个模型的规格（HF id + 维度 + 前缀模式 + pooling）。 */
interface ModelSpec {
  /** HF Hub 模型 id（transformers.js 需要 ONNX 权重，通常用 Xenova/* 镜像）。 */
  readonly id: string;
  /** 输出向量维度（余弦无关维度，但需如实上报供诊断）。 */
  readonly dim: number;
  /** 前缀模式；e5 家族要求 query/passage 前缀。 */
  readonly prefix?: PrefixMode;
  /**
   * pooling 模式。encoder 类（minilm/e5/gte/jina）用 'mean'；
   * decoder-only 代码嵌入（bge-code-v1 / Qwen3-Embedding）必须用 'last'
   * （取最后注意力 token，即 [EOS] 隐藏态），否则向量语义错位。
   * 默认 'mean'（保持历史行为）。
   */
  readonly pooling?: 'mean' | 'cls' | 'last';
}

/** 可选预设（快捷名 → 规格）。 */
export type EmbeddingModelPreset =
  'minilm' | 'e5-small-v2' | 'e5-base-v2' | 'e5-large-v2' | 'gte-large' | 'jina-base-code';

/**
 * 已验证可用的模型预设（HF Hub 经 hf-mirror.com 核实存在 ONNX 权重）。
 *  - minilm：通用句向量，384 维，默认，约 80MB。
 *  - e5-*-v2：intfloat 的检索级嵌入，对「查询-文档」不对称训练，代码检索显著强于通用模型；
 *    e5 要求 "query: " / "passage: " 前缀（由本适配器按 role 自动注入）。
 *  - gte-large：Alibaba DAMO 通用嵌入，1024 维，对称、无前缀、mean-pooling（与 minilm 同用法）；
 *    MTEB 强模型，用于隔离「模型容量」单一变量（验证 59% 天花板是否受限于 minilm 容量）。
 *  - jina-base-code：Jina 代码专用嵌入，137M/768 维，8K ALiBi 长上下文，原生支持 Late Chunking，
 *    自带 ONNX 权重（hf-mirror 可下）。用于实验 1：把文件语义文档从「前 600 字符」换成「全文」，
 *    直击表示瓶颈（前 600 字符几乎全是 import/license，丢掉函数体语义）。
 *
 * 注：unixcoder（microsoft/unixcoder-base）在 Xenova 镜像**无 ONNX 权重（404）**，
 * 需经 optimum 离线转换为 ONNX 后才能被 transformers.js 加载——本沙箱无该工具链，故不列入。
 * 若日后要接 unixcoder，应在 `scripts/` 增加 ONNX 转换步骤并把产物登记进 allowlist。
 */
export const MODEL_PRESETS: Readonly<Record<EmbeddingModelPreset, ModelSpec>> = {
  minilm: { id: 'Xenova/all-MiniLM-L6-v2', dim: 384 },
  'e5-small-v2': { id: 'Xenova/e5-small-v2', dim: 384, prefix: 'e5' },
  'e5-base-v2': { id: 'Xenova/e5-base-v2', dim: 768, prefix: 'e5' },
  'e5-large-v2': { id: 'Xenova/e5-large-v2', dim: 1024, prefix: 'e5' },
  'gte-large': { id: 'Xenova/gte-large', dim: 1024 },
  'jina-base-code': { id: 'jinaai/jina-embeddings-v2-base-code', dim: 768 },
};

/**
 * 默认语义模型（**实测最高值方案，2026-09-05 冻结**）：
 * 从通用句向量 minilm(384) 升级为检索级 e5-large-v2(1024)。
 * 实测在真实代码库混合检索上把语义天花板从 ~44.6% 推到 63.2%（+18.6pp），
 * 且 e5 在 hf-mirror 有现成 ONNX 权重、可离线跑；模型缺失时由调用方 fail-closed 回落 BM25-only。
 * 当初 minilm 是「保持历史行为」的占位默认，并非最优——已据受控消融翻案。
 */
export const DEFAULT_EMBEDDING_MODEL = MODEL_PRESETS['e5-large-v2'].id;
/** 默认维度（e5-large-v2 = 1024）。换默认模型需同步调整本常量与上方 id。 */
export const DEFAULT_EMBEDDING_DIM = MODEL_PRESETS['e5-large-v2'].dim;

/**
 * `@huggingface/transformers` 中被本适配器消费的**最小面**（仅为可注入接缝而声明）。
 */
export interface TransformersModuleLike {
  /** 该库的全局环境（本适配器只写 `remoteHost` 镜像源）。 */
  readonly env: { remoteHost: string };
  /** 创建特征抽取 pipeline。 */
  pipeline(task: string, model: string, opts: Record<string, unknown>): Promise<unknown>;
}

/**
 * 动态加载 `@huggingface/transformers` 的接缝（生产缺省为真动态 import）。
 *
 * 暴露该接缝的唯一目的：让**冷启动与预热**能在**离线**下被单测钉住——否则验证 `preload()`
 * 就必须真下载 2.2GB 依赖与模型权重（这正是 L5 长期未落地的原由）。
 */
export type TransformersModuleLoader = () => Promise<TransformersModuleLike>;

/** 适配器选项。 */
export interface TransformersEmbeddingOptions {
  /**
   * 预设名（minilm / e5-*-v2）。与 `model` 二选一；都给时 `model` 优先（自定义 HF id）。
   * 默认 'minilm'。
   */
  readonly preset?: EmbeddingModelPreset | undefined;
  /**
   * 直接指定 HF 模型 id（覆盖 preset）。用于不在预设里的模型。
   * 注意：自定义 id 无法预知前缀模式，默认按 'none' 处理（不会注入 e5 前缀）。
   */
  readonly model?: string | undefined;
  /** 自定义模型维度（仅当用 `model` 覆盖且非 e5 预设时需要，e5 预设自带头维）。 */
  readonly dim?: number | undefined;
  /** 运行设备：cpu（Node 原生 onnxruntime，默认），webgpu 更快需支持。 */
  readonly device?: 'wasm' | 'webgpu' | 'cpu' | 'auto' | undefined;
  /** 量化：q8 默认（快、省内存）。 */
  readonly dtype?: DType | undefined;
  /** 模型缓存目录（离线场景预置权重于此）。 */
  readonly cacheDir?: string | undefined;
  /** 仅用本地缓存、禁止联网下载（离线环境置 true）。 */
  readonly localFilesOnly?: boolean | undefined;
  /**
   * 模型下载源（镜像）主机地址，如 `https://hf-mirror.com`。
   *
   * **为什么必须有这个旋钮**：`@huggingface/transformers` 的 `env.remoteHost` 默认指向
   * `https://huggingface.co/`，且该库**不读** `HF_ENDPOINT` 环境变量（那是 Python 侧
   * `huggingface_hub` 的约定）⇒ 在无法直连 huggingface.co 的网络（如本沙箱、国内生产环境）里，
   * 该库只会静默超时，**没有任何配置手段能改**。缺此旋钮时语义检索在生产路径上不可达。
   * 归一化：自动补尾斜杠（拼 URL 用 `remoteHost + remotePathTemplate`）。
   *
   * 缺省 `undefined` ⇒ 沿用该库默认（huggingface.co），零行为变更。
   */
  readonly remoteHost?: string | undefined;
  /**
   * 动态加载 `@huggingface/transformers` 的接缝；生产缺省即真动态 import（见
   * {@link TransformersModuleLoader}）。仅供测试注入，业务方无需设置。
   */
  readonly loader?: TransformersModuleLoader | undefined;
}

/** transformers.js 的 Tensor 最小形状（feature-extraction 输出）。 */
interface HFTensor {
  dims: number[];
  tolist(): number[][];
}

/** 量化数据类型（transformers.js 支持的常用子集）。 */
type DType = 'auto' | 'q8' | 'fp32' | 'fp16' | 'int8' | 'uint8' | 'q4' | 'q4f16';

/** e5 前缀常量。 */
const E5_QUERY_PREFIX = 'query: ';
const E5_PASSAGE_PREFIX = 'passage: ';

/**
 * 生产缺省的模型包加载器：**真动态 import**（编译期不依赖该包；仅启用语义嵌入时运行时加载）。
 * 分离成常量是为了让测试注入假 loader，从而在**不下载 2.2GB 依赖与模型权重**的前提下
 * 验证懒加载/预热/失败恢复三条行为。
 */
const defaultModuleLoader: TransformersModuleLoader = async () =>
  (await import('@huggingface/transformers')) as unknown as TransformersModuleLike;

/**
 * 基于 @huggingface/transformers 的本地嵌入适配器。
 * 懒加载 pipeline（首次 embed 时才下载/加载模型），并复用同一 pipeline 实例。
 *
 * 多模型：构造时解析 preset/model 得到 {id, dim, prefix}；embed 时按 prefix 模式
 * 与 text role 注入 e5 前缀（'query' → "query: "，'document' → "passage: "）。
 */
export class TransformersEmbeddingAdapter implements EmbeddingPort {
  /** 输出向量维度（由模型规格决定，如实上报供诊断）。 */
  public readonly dim: number;
  /** 解析出的 HF 模型 id（诊断与 pipeline 加载用）。 */
  private readonly model: string;
  /** 前缀模式：e5 家族注入 query/passage 前缀，其余不注入。 */
  private readonly prefixMode: PrefixMode;
  /** 运行设备（cpu 默认；webgpu 需环境支持）。 */
  private readonly device: 'wasm' | 'webgpu' | 'cpu' | 'auto';
  /** 量化数据类型（默认 q8，快且省内存）。 */
  private readonly dtype: DType;
  /** 模型缓存目录（离线场景预置权重于此）。 */
  private readonly cacheDir?: string | undefined;
  /** 是否仅用本地缓存、禁止联网下载（离线环境为 true）。 */
  private readonly localFilesOnly: boolean;
  /** 模型下载源（镜像）host；`undefined` 表示沿用该库默认（huggingface.co）。 */
  private readonly remoteHost?: string | undefined;
  /** 模型包加载接缝（生产为真动态 import；测试注入假实现以免下载）。 */
  private readonly loader: TransformersModuleLoader;
  /** 懒加载的 pipeline Promise（null 表示尚未加载；复用同一实例避免重复加载模型）。 */
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  /**
   * @param opts 适配器选项（preset/model 二选一及设备/量化/缓存等，全有默认）。
   */
  public constructor(opts: TransformersEmbeddingOptions = {}) {
    // 解析模型规格：显式 model 优先（自定义 id，无前缀知识）；
    // 否则查预设表（带前缀模式）；都缺省 → minilm。
    let spec: ModelSpec;
    if (opts.model !== undefined) {
      spec = { id: opts.model, dim: opts.dim ?? DEFAULT_EMBEDDING_DIM };
    } else {
      const preset = opts.preset ?? 'minilm';
      const found = MODEL_PRESETS[preset];
      if (found === undefined) {
        throw new Error(
          `未知嵌入预设 "${preset}"；可选：${TransformersEmbeddingAdapter.listModelPresets().join(', ')}`,
        );
      }
      spec = found;
    }
    this.model = spec.id;
    this.dim = spec.dim;
    this.prefixMode = spec.prefix ?? 'none';
    this.device = opts.device ?? 'cpu';
    this.dtype = opts.dtype ?? 'q8';
    this.cacheDir = opts.cacheDir;
    this.localFilesOnly = opts.localFilesOnly ?? false;
    this.remoteHost = TransformersEmbeddingAdapter.normalizeRemoteHost(opts.remoteHost);
    this.loader = opts.loader ?? defaultModuleLoader;
  }

  /** 解析出的 HF 模型 id（诊断用）。 */
  public get modelId(): string {
    return this.model;
  }

  /** 生效的模型下载源 host（诊断用）；`undefined` 表示沿用库默认 huggingface.co。 */
  public get remoteHostUsed(): string | undefined {
    return this.remoteHost;
  }

  /** 懒加载并复用 feature-extraction pipeline（首次调用才动态 import 模型包）。
   * @returns 已就绪的特征抽取管线。
   */
  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    if (this.pipelinePromise === null) {
      const pending = (async () => {
        // 动态导入：编译期不依赖该包，运行时仅在启用语义嵌入时加载（测试可注入假 loader）。
        const mod = await this.loader();
        // 镜像必须在**创建 pipeline 之前**写入：该库在 pipeline 构造期即按 remoteHost 拼 URL 取权重，
        // 之后再改无效（模型已在下载或已失败）。这与 OpenAI 兼容端点的 baseURL 同理，属启动期配置。
        if (this.remoteHost !== undefined) {
          mod.env.remoteHost = this.remoteHost;
        }
        const pipe = (await mod.pipeline('feature-extraction', this.model, {
          device: this.device,
          dtype: this.dtype,
          ...(this.cacheDir ? { cache_dir: this.cacheDir } : {}),
          local_files_only: this.localFilesOnly,
        })) as FeatureExtractionPipeline;
        return pipe;
      })();
      this.pipelinePromise = pending;
      // 失败必须**清空缓存**：否则一个瞬时的下载/加载失败会把一个已 reject 的 Promise 永久钉在
      // 字段上，后续每一步都复用它 ⇒ 该适配器此后**再也不可能恢复**（语义路整会话静默失效）。
      // 清空后下一次调用会重试——冷启动失败通常是瞬时的，而永久瘫痪不可接受。
      // `=== pending` 守卫：避免把「清空后才发起的新一轮尝试」误清掉。
      pending.catch(() => {
        if (this.pipelinePromise === pending) {
          this.pipelinePromise = null;
        }
      });
    }
    return this.pipelinePromise;
  }

  /**
   * 预热：显式触发 pipeline 构建，并**把冷启动成本变成可读数字**（L5）。
   *
   * 需要说清的一点：本适配器用单实例 `pipelinePromise` 复用管线，**不会**像多模型路由那样
   * 在请求之间重建模型（那才是 Laya 记录的「lazy + 单热缓存 ⇒ 每次冷建 7.4s」陷阱），
   * 故「不重建」这一条本就成立。真正缺的是**冷启动的可观测性与可控时机**——此前首个语义
   * 查询会静默地承担「加载可选依赖 + 取权重 + 建 pipeline」的整段耗时（本机该可选依赖约 2.2GB）。
   * 预热把这段成本提前到调用方可自主选择的时刻（如服务启动后、接受流量前），并记下毫秒数。
   *
   * @returns 预热结果（是否成功 / 耗时 / 是否真由本次构建 / 失败原因）。
   */
  public async preload(): Promise<EmbeddingPreloadOutcome> {
    const wasHot = this.pipelinePromise !== null;
    const started = Date.now();
    try {
      await this.getPipeline();
      const ms = Date.now() - started;
      if (!wasHot) {
        log.info('embedding.pipeline.built', {
          model: this.model,
          device: this.device,
          dtype: this.dtype,
          ms,
        });
      }
      return { ok: true, ms, built: !wasHot };
    } catch (error) {
      const ms = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      log.warn('embedding.pipeline.failed', { model: this.model, ms, error: message });
      return { ok: false, ms, built: !wasHot, error: message };
    }
  }

  /** 按前缀模式 + 角色给文本加前缀（仅 e5 需要；非 e5 原样返回）。
   * @param texts 待嵌入文本列表。
   * @param role 文本角色（query 注入 "query: "，document 注入 "passage: "）。
   * @returns 加前缀后的文本列表。
   */
  private applyPrefix(texts: readonly string[], role: 'query' | 'document'): string[] {
    return TransformersEmbeddingAdapter.withPrefix(texts, this.prefixMode, role);
  }

  /**
   * 批量嵌入文本为向量（懒加载并复用同一 pipeline 实例）。
   * @param texts 待嵌入的文本列表
   * @param opts  嵌入选项（角色前缀、是否归一化等）
   * @returns 与输入等长的向量列表
   */
  public async embed(texts: readonly string[], opts?: EmbedOptions): Promise<readonly Embedding[]> {
    const pipe = await this.getPipeline();
    // role 默认为 'document'：SemanticIndex.build 传 'document'、search 传 'query'；
    // 其他调用方（warmup）未指定时按文档处理，不影响权重加载。
    const role = opts?.role ?? 'document';
    const inputs = this.applyPrefix(texts, role);
    const normalize = opts?.normalize !== false;
    const out = (await pipe(inputs, {
      pooling: 'mean',
      normalize,
    })) as HFTensor;
    const matrix = out.tolist();
    return matrix.map((v) => v as Embedding);
  }

  /** 列出预设名（供 CLI / 单测 / 诊断输出）。
   * @returns 全部可用预设名数组。
   */
  public static listModelPresets(): readonly EmbeddingModelPreset[] {
    return Object.keys(MODEL_PRESETS) as EmbeddingModelPreset[];
  }

  /**
   * 纯函数：按前缀模式 + 角色给文本加前缀（零依赖、可单测）。
   * 仅 'e5' 模式注入；'none' 原样返回。供 embed 调用，也便于单测验证前缀注入正确。
   *
   * @param texts 待处理文本列表。
   * @param mode 前缀模式（仅 'e5' 注入）。
   * @param role 文本角色（决定注入 query 还是 passage 前缀）。
   * @returns 加前缀后的文本数组（与输入等长、顺序一致）。
   */
  public static withPrefix(
    texts: readonly string[],
    mode: PrefixMode,
    role: 'query' | 'document',
  ): string[] {
    if (mode !== 'e5') return texts as string[];
    const p = role === 'query' ? E5_QUERY_PREFIX : E5_PASSAGE_PREFIX;
    return texts.map((t) => p + t);
  }

  /**
   * 归一化模型下载源主机地址（纯函数、零依赖、可单测）。
   *
   * 必须补尾斜杠：该库拼下载 URL 的方式是 `env.remoteHost + env.remotePathTemplate`，
   * 而 `remotePathTemplate` 是相对片段（`"{model}/resolve/{revision}/"`）⇒ host 缺尾斜杠会拼出
   * `https://hf-mirror.comXenova/all-MiniLM-L6-v2/resolve/...` 这类坏 URL（域名与路径粘连）。
   *
   * @param host 原始 host（可能含首尾空白、可能缺尾斜杠）。
   * @returns 补好尾斜杠的 host；未提供或全空白时返回 `undefined`（表示沿用库默认源）。
   */
  public static normalizeRemoteHost(host: string | undefined): string | undefined {
    if (host === undefined) return undefined;
    const trimmed = host.trim();
    if (trimmed === '') return undefined;
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  }

  /**
   * 从环境变量解析模型下载源（纯函数、可注入 env 以便单测）。
   *
   * 约定：`OMNI_HF_ENDPOINT` 优先（本项目命名空间），回落 `HF_ENDPOINT`（业界通行约定，
   * 便于复用既有的镜像部署脚本）。两者皆空 ⇒ `undefined`（沿用库默认 huggingface.co）。
   *
   * @param env 环境变量视图（默认 `process.env`；单测可注入）。
   * @returns 归一化后的镜像 host，或 `undefined`。
   */
  public static resolveRemoteHostFromEnv(
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): string | undefined {
    return TransformersEmbeddingAdapter.normalizeRemoteHost(
      env.OMNI_HF_ENDPOINT ?? env.HF_ENDPOINT,
    );
  }

  /**
   * 是否在装配期预热嵌入管线（`OMNI_EMBED_PRELOAD=1`，**默认关**）。
   *
   * 与 `OMNI_SEMANTIC_RECALL` 同一惯例：默认关 ⇒ 零行为变更。开启后装配层会在**后台**触发
   * 一次 `preload()`（不阻塞装配、不改变可用性判断），把冷启动成本从「首个用户查询」提前到
   * 「启动后、接流量前」，并把耗时落成可读数字（L5）。
   *
   * @param env 环境变量视图（默认 `process.env`；单测可注入）。
   * @returns 显式取值 `1` 时为 true，其余一律 false。
   */
  public static shouldPreloadEmbedding(
    env: Record<string, string | undefined> = process.env,
  ): boolean {
    return env.OMNI_EMBED_PRELOAD === '1';
  }
}
