/**
 * Laya 决策引擎适配器（本地 System-1 推理）：经子进程调本地 Python `laya` 包，用单次前向
 * 完成 `choice` / `score` / `noul` 类型化决策。
 *
 * 为什么走 Python 子进程（而非纯 TS onnxruntime）：Laya 官方实现（路由 / typed-decisions /
 * 校准温度）已成熟且 Apache-2.0，直接复用避免重新实现 head 逻辑。子进程纪律（仓库铁律）：
 * 一律显式 `stdio:['ignore','pipe','ignore']`，避开本机 `spawnSync ... EBUSY`。
 *
 * 权重源：HuggingFace 官方 `convaiinnovations/laya` 系列在本机不可达，统一走
 * `HF_ENDPOINT=https://hf-mirror.com` 镜像（记忆环境约束）。
 *
 * fail-open：Python 不可用 / 调用失败 / 超时 ⇒ `decide` 返回 `{ available:false }`，不抛错、
 * 不阻断主流程（决策引擎是质量信号，非安全边界）。
 *
 * @maturity L1 — 端口/适配器骨架已落地并接 self-verify shadow 观测；真实端到端证据待本地
 *   `laya` 后端（torch + 421M 权重）安装后补齐（见看板 §34）。
 * @maturityEvidence tests/unit/decisionEngine.test.ts, tests/unit/layaWiring.test.ts, tests/unit/selfVerifyVerdictProbe.test.ts
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  DecisionEngine,
  DecisionRequest,
  DecisionResponse,
} from '../../ports/decision/decisionEngine.js';

/** Laya 适配器配置。 */
export interface LayaDecisionEngineOptions {
  /** Python 解释器路径（缺省 `python3`）。 */
  readonly pythonPath?: string;
  /** 推理脚本路径（缺省与本文件同目录的 `laya_infer.py`）。 */
  readonly scriptPath?: string;
  /** 单次决策超时（毫秒，默认 30000）。 */
  readonly timeoutMs?: number;
  /** HuggingFace 镜像端点（默认 https://hf-mirror.com）。 */
  readonly hfEndpoint?: string;
  /** 选用的 checkpoint repo（默认 `convaiinnovations/laya-typed-decisions`，最贴合本仓 typed 工作流）。 */
  readonly repo?: string;
}

/** 默认单次决策超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 默认 HuggingFace 镜像端点。 */
const DEFAULT_HF_ENDPOINT = 'https://hf-mirror.com';

/** 默认 checkpoint repo。 */
const DEFAULT_REPO = 'convaiinnovations/laya-typed-decisions';

/**
 * Laya 决策引擎适配器：本地 Python `laya` 包桥。
 */
export class LayaDecisionEngine implements DecisionEngine {
  /** 端口名。 */
  public readonly name = 'laya';

  /** Python 解释器路径。 */
  private readonly pythonPath: string;

  /** 推理脚本路径。 */
  private readonly scriptPath: string;

  /** 单次决策超时（毫秒）。 */
  private readonly timeoutMs: number;

  /** HuggingFace 镜像端点。 */
  private readonly hfEndpoint: string;

  /** 选用的 checkpoint repo。 */
  private readonly repo: string;

  /** 可用性探测结果缓存（undefined 表示尚未探测）。 */
  private availability: boolean | undefined = undefined;

  /**
   * @param options 适配器配置（全部可选，缺省取环境无关保守值）。
   */
  public constructor(options: LayaDecisionEngineOptions = {}) {
    this.pythonPath = options.pythonPath ?? 'python3';
    const here = dirname(fileURLToPath(import.meta.url));
    this.scriptPath = options.scriptPath ?? join(here, 'laya_infer.py');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.hfEndpoint = options.hfEndpoint ?? DEFAULT_HF_ENDPOINT;
    this.repo = options.repo ?? DEFAULT_REPO;
  }

  /**
   * 探测后端是否可用（导入 `laya` 包即可，不触发权重下载）。结果缓存。
   *
   * @returns 可用时为 true。
   */
  public isAvailable(): boolean {
    if (this.availability !== undefined) {
      return this.availability;
    }
    try {
      const probe = JSON.stringify({ repo: this.repo, probe: true });
      execFileSync(this.pythonPath, [this.scriptPath], {
        input: probe,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: this.timeoutMs,
        env: { ...process.env, HF_ENDPOINT: this.hfEndpoint },
        windowsHide: true,
      });
      this.availability = true;
    } catch {
      this.availability = false;
    }
    return this.availability;
  }

  /**
   * 单次前向类型化决策（经 Python 子进程）。
   *
   * 后端不可用 / 调用失败 / 超时一律返回 `{ available:false }`（fail-open，不抛错）。
   *
   * @param request 决策请求。
   * @returns 决策响应。
   */
  public async decide(request: DecisionRequest): Promise<DecisionResponse> {
    if (!this.isAvailable()) {
      return { answers: {}, available: false, note: 'laya 后端不可用（fail-open）' };
    }
    try {
      const payload = JSON.stringify({ repo: this.repo, request });
      const raw = execFileSync(this.pythonPath, [this.scriptPath], {
        input: payload,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: this.timeoutMs,
        env: { ...process.env, HF_ENDPOINT: this.hfEndpoint },
        windowsHide: true,
      });
      const parsed = JSON.parse(raw.toString('utf8')) as DecisionResponse;
      return { ...parsed, available: true };
    } catch (error) {
      return {
        answers: {},
        available: false,
        note: `laya 调用失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
