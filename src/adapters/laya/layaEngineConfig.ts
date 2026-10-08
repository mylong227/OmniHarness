/**
 * Laya 决策引擎的**配置解析与预算快照**（从适配器主类抽出）。
 *
 * ## 为什么独立成文件
 *
 * 适配器主类原先自己持有 12 个配置字段（解释器 / 权重 / 各种预算），成员数越过
 * `scripts/auditStandards.mjs` 的「上帝类」判据（含类文件 >25 成员即红）。按本仓惯例
 * **抽出去而不是放宽阈值**：配置解析与推理编排本来就是两件事，前者是纯函数式的
 * 「选项 → 解析结果」，后者才是有状态的生命周期管理。
 *
 * 顺带把「预算」的口径集中到一处，避免同一件事在文档、解析、使用时各写一份：
 * 热路径预算 = `min(requestTimeoutMs, timeoutMs)`（`timeoutMs` 是用户可配的单次决策上限）。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LayaPaths } from './layaPaths.js';

/** Laya 适配器配置（全部可选；缺省即「零配置可用」）。 */
export interface LayaDecisionEngineOptions {
  /** Python 解释器路径（缺省：`LAYA_PYTHON_BIN` → 项目内 venv → 平台兜底名）。 */
  readonly pythonPath?: string;
  /** 推理脚本路径（缺省与本目录的 `laya_infer.py`）。 */
  readonly scriptPath?: string;
  /** 单次决策上限（毫秒，默认 120000）：同时约束单发路径与热路径（热路径取它与 `requestTimeoutMs` 的较小者）。 */
  readonly timeoutMs?: number;
  /** HuggingFace 镜像端点（默认 https://hf-mirror.com）。 */
  readonly hfEndpoint?: string;
  /** 选用的 checkpoint repo（默认 `convaiinnovations/laya`；有本地权重目录时该值仅作标识）。 */
  readonly repo?: string;
  /** 本地已下载的 checkpoint 目录（缺省：`LAYA_MODEL_DIR` → 项目内 `third-party/laya-model`）。 */
  readonly modelDir?: string;
  /** 是否复用常驻热进程（默认 true；false 时每次决策单起一次性子进程）。 */
  readonly warm?: boolean;
  /** 探测预算（毫秒，默认 5000）：仅用于 `import laya` 探测；**未就绪时的决策不等待**（直接跳过，0 延迟）。 */
  readonly warmupWaitMs?: number;
  /** 热路径单次请求上限（毫秒，默认 15000）；实际生效值为它与 `timeoutMs` 的较小者。 */
  readonly requestTimeoutMs?: number;
  /** 权重加载预算（毫秒，默认 180000）：`warmup` 帧上限；**必须有界**（否则卡死的加载会永久卡住加载态）。 */
  readonly loadTimeoutMs?: number;
  /** 空转回收（毫秒，默认 600000）：空闲即关掉子进程释放内存，下次请求自动重启。 */
  readonly idleShutdownMs?: number;
  /** 负结果缓存时长（毫秒，默认 60000）：探测失败后多久允许重探（正结果永久缓存）。 */
  readonly availabilityRetryMs?: number;
}

/** 适配器的解析结果（供诊断日志 / 单测断言「连到哪个解释器与权重、用多长预算」）。 */
export interface LayaEngineResolution {
  /** 实际使用的解释器路径。 */
  readonly pythonPath: string;
  /** 实际使用的桥脚本路径。 */
  readonly scriptPath: string;
  /** 实际使用的权重目录（空串 = 在线 Router）。 */
  readonly modelDir: string;
  /** 是否启用常驻热进程。 */
  readonly warm: boolean;
  /** 热路径单次请求的**实际**预算（毫秒）= `min(requestTimeoutMs, timeoutMs)`。 */
  readonly warmRequestTimeoutMs: number;
  /** 权重加载预算（毫秒）。 */
  readonly loadTimeoutMs: number;
}

/** 单次决策默认上限（毫秒）：覆盖本机实测的**单发**冷启 62.4s，同时作为热路径的上限之一。 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** 热路径单次请求上限（毫秒）：实测 0.4–1.3s，留足一个数量级余量。 */
const DEFAULT_WARM_REQUEST_TIMEOUT_MS = 15_000;

/** 权重加载预算（毫秒）：本机实测 12.7–24s，取 3 分钟作为「卡死」与「慢」的分界。 */
const DEFAULT_LOAD_TIMEOUT_MS = 180_000;

/**
 * 探测预算（毫秒）：`import laya` 在 venv 里单独实测 0.41s，**端到端探测**（起进程 + 导入 + 回帧）
 * 实测 0.58–0.71s、冷启 1.65s。取 5s：既容得下冷启，又不会让「后端真的坏了」长时间挂住探针
 * （2026-10-07 评审指出原 1.5s 只有约 2× 余量——在那种余量下，一次抖动就把 Laya 判死）。
 */
const DEFAULT_WARMUP_WAIT_MS = 5_000;

/** 空转回收（毫秒）：10 分钟无请求即释放常驻内存（约 2GB）。 */
const DEFAULT_IDLE_SHUTDOWN_MS = 600_000;

/** 负结果缓存时长（毫秒）：探测失败后 60s 允许重探（正结果永久缓存）。 */
const DEFAULT_AVAILABILITY_RETRY_MS = 60_000;

/** 默认 HuggingFace 镜像端点（本机直连 huggingface.co 不可达）。 */
const DEFAULT_HF_ENDPOINT = 'https://hf-mirror.com';

/** 默认 checkpoint repo（英文根 checkpoint；仅在线路径生效）。 */
const DEFAULT_REPO = 'convaiinnovations/laya';

/**
 * 解析后的配置快照：路径解析链、权重目录、各档预算（不可变）。
 */
export class LayaEngineConfig {
  /** Python 解释器路径（零配置解析结果）。 */
  public readonly pythonPath: string;

  /** 桥脚本路径。 */
  public readonly scriptPath: string;

  /** 单次决策上限（毫秒）。 */
  public readonly timeoutMs: number;

  /** HuggingFace 镜像端点。 */
  public readonly hfEndpoint: string;

  /** checkpoint repo（在线路径用）。 */
  public readonly repo: string;

  /** 权重目录（空串 = 在线 Router）。 */
  public readonly modelDir: string;

  /** 是否复用常驻热进程。 */
  public readonly warm: boolean;

  /** 探测预算（毫秒）。 */
  public readonly warmupWaitMs: number;

  /** 热路径单次请求上限（毫秒）。 */
  public readonly requestTimeoutMs: number;

  /** 权重加载预算（毫秒）。 */
  public readonly loadTimeoutMs: number;

  /** 空转回收（毫秒）。 */
  public readonly idleShutdownMs: number;

  /** 负结果缓存时长（毫秒）。 */
  public readonly availabilityRetryMs: number;

  /**
   * @param from 起始目录（用于定位项目根；通常为适配器所在目录）。
   * @param options 适配器配置（全部可选）。
   */
  public constructor(from: string, options: LayaDecisionEngineOptions = {}) {
    this.scriptPath = options.scriptPath ?? join(from, 'laya_infer.py');
    this.pythonPath = LayaPaths.pythonPath(from, options.pythonPath);
    this.modelDir = LayaPaths.modelDir(from, options.modelDir);
    this.hfEndpoint = options.hfEndpoint ?? DEFAULT_HF_ENDPOINT;
    this.repo = options.repo ?? DEFAULT_REPO;
    this.warm = options.warm ?? true;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.warmupWaitMs = options.warmupWaitMs ?? DEFAULT_WARMUP_WAIT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_WARM_REQUEST_TIMEOUT_MS;
    this.loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
    this.idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    this.availabilityRetryMs = options.availabilityRetryMs ?? DEFAULT_AVAILABILITY_RETRY_MS;
  }

  /**
   * 以适配器自身所在目录为基准解析配置（`import.meta.url` 推导，避免调用方传路径）。
   *
   * @param options 适配器配置（全部可选）。
   * @returns 配置快照。
   */
  public static resolve(options: LayaDecisionEngineOptions = {}): LayaEngineConfig {
    return new LayaEngineConfig(dirname(fileURLToPath(import.meta.url)), options);
  }

  /**
   * 热路径单次请求的**实际**预算：`timeoutMs` 是用户可配的单次决策上限，更小时以它为准。
   *
   * @returns 实际生效毫秒数。
   */
  public warmRequestBudgetMs(): number {
    return Math.min(this.requestTimeoutMs, this.timeoutMs);
  }

  /**
   * 解析结果快照（供诊断日志与单测断言）。
   *
   * @returns 解析结果。
   */
  public resolution(): LayaEngineResolution {
    return {
      pythonPath: this.pythonPath,
      scriptPath: this.scriptPath,
      modelDir: this.modelDir,
      warm: this.warm,
      warmRequestTimeoutMs: this.warmRequestBudgetMs(),
      loadTimeoutMs: this.loadTimeoutMs,
    };
  }
}
