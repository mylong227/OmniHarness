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
 * @maturity L2 — 本地 `laya` 后端（torch 2.14 CPU + 421M 权重）已安装，TS 适配器 → Python
 *   桥 → 本地 `Agent` 单次前向真实推理已端到端验证（noul/score 数值落合理区间，见看板 §34）。
 * @maturityEvidence tests/unit/decisionEngine.test.ts, tests/unit/layaWiring.test.ts, tests/unit/selfVerifyVerdictProbe.test.ts, tests/integration/layaBackend.test.ts
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  DecisionEngine,
  DecisionQuestion,
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
  /** 选用的 checkpoint repo（默认 `convaiinnovations/laya` 英文根 checkpoint；Router 默认 english）。 */
  readonly repo?: string;
  /** 本地已下载的 checkpoint 目录（离线推理用，默认取环境变量 `LAYA_MODEL_DIR`）。给定时 predict 走本地、不触网。 */
  readonly modelDir?: string;
}

/** 默认单次决策超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 默认 HuggingFace 镜像端点。 */
const DEFAULT_HF_ENDPOINT = 'https://hf-mirror.com';

/** 默认 checkpoint repo（英文根 checkpoint；Router 默认 english）。 */
const DEFAULT_REPO = 'convaiinnovations/laya';

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

  /** 本地已下载的 checkpoint 目录（离线推理用）。 */
  private readonly modelDir: string;

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
    this.modelDir = options.modelDir ?? process.env.LAYA_MODEL_DIR ?? '';
  }

  /**
   * 把请求 JSON 写入临时文件并返回路径（调用方负责用完删除）。
   *
   * 请求走文件而非 stdin 管道：本机 Windows 同步子进程一旦建 stdin 管道必 EBUSY，故仓库
   * 铁律要求子进程一律 `stdio:['ignore','pipe','ignore']`（stdin 接 `/dev/null`），`input`
   * 选项会被静默丢弃。改用 `--request-file` 传参既避开 EBUSY，又可靠投递请求。
   *
   * @param payload 请求 JSON 字符串。
   * @returns 临时文件绝对路径。
   */
  private writeRequestFile(payload: string): string {
    const path = join(tmpdir(), `laya-req-${randomUUID()}.json`);
    writeFileSync(path, payload, 'utf8');
    return path;
  }

  /**
   * 经子进程调 Python 桥完成单次推理（请求走临时文件），返回桥原始 stdout。
   *
   * @param payload 请求 JSON 字符串。
   * @returns 桥的 stdout（utf-8 字符串）。
   */
  private runBridge(payload: string): string {
    const reqFile = this.writeRequestFile(payload);
    try {
      const raw = execFileSync(this.pythonPath, [this.scriptPath, '--request-file', reqFile], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: this.timeoutMs,
        env: { ...process.env, HF_ENDPOINT: this.hfEndpoint },
        windowsHide: true,
      });
      return raw.toString('utf8');
    } finally {
      try {
        unlinkSync(reqFile);
      } catch {
        /* 临时文件清理失败不阻断主流程 */
      }
    }
  }

  /**
   * 探测后端是否可用（导入 `laya` 包即可，不触发权重下载）。结果缓存。
   *
   * 解析桥的真实响应：`available` 为 true 才认为可用（避免静默把坏后端当可用）。
   *
   * @returns 可用时为 true。
   */
  public isAvailable(): boolean {
    if (this.availability !== undefined) {
      return this.availability;
    }
    let ok = false;
    try {
      const probe = JSON.stringify({ repo: this.repo, probe: true });
      const out = this.runBridge(probe);
      const parsed = JSON.parse(out) as { available?: boolean };
      ok = parsed.available === true;
    } catch {
      ok = false;
    }
    this.availability = ok;
    return this.availability;
  }

  /**
   * 把端口契约的 `DecisionQuestion`（`kind`）翻译成 Laya 线格式（`type`）。
   *
   * 这是六边形适配器的职责：端口（第三方-free、`kind`）与推理实现（Laya wire、`type`）
   * 之间的线格式翻译。映射规则：
   * - `noul`   → `{ type: "noul", instructions }`
   * - `choice` → `{ type: "choice", instructions, criteria: { 类别: null } }`
   * - `score`  → `{ type: "score", instructions, criteria: string[] }`
   *
   * @param question 端口问题定义。
   * @returns Laya `router.predict` 接受的 question dict。
   */
  private toLayaQuestion(question: DecisionQuestion): Record<string, unknown> {
    const base: Record<string, unknown> = { instructions: question.instructions };
    switch (question.kind) {
      case 'noul':
        return { type: 'noul', ...base };
      case 'choice': {
        const criteria = question.criteria as Readonly<Record<string, string>> | undefined;
        const layaCriteria: Record<string, null> = {};
        if (criteria !== undefined) {
          for (const label of Object.keys(criteria)) {
            layaCriteria[label] = null;
          }
        }
        return { type: 'choice', ...base, criteria: layaCriteria };
      }
      case 'score': {
        const levels = (question.criteria as readonly string[] | undefined) ?? [];
        return { type: 'score', ...base, criteria: [...levels] };
      }
    }
  }

  /**
   * 把整组端口问题翻译成 Laya 线格式（保持问题名对齐）。
   *
   * @param questions 端口问题集（键为问题名）。
   * @returns Laya question dict 集。
   */
  private toLayaQuestions(
    questions: Readonly<Record<string, DecisionQuestion>>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, question] of Object.entries(questions)) {
      out[name] = this.toLayaQuestion(question);
    }
    return out;
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
      const layaQuestions = this.toLayaQuestions(request.questions);
      const payload = JSON.stringify({
        repo: this.repo,
        modelDir: this.modelDir || undefined,
        request: { state: request.state, questions: layaQuestions },
      });
      const out = this.runBridge(payload);
      const parsed = JSON.parse(out) as DecisionResponse;
      // 桥已带 `available`（true/false）；不再强制 true，避免掩盖 fail-open——桥在测试
      // 上下文失败时会回 `available:false` 且无 `answers`，应如实透传而非伪装成功。
      return parsed;
    } catch (error) {
      return {
        answers: {},
        available: false,
        note: `laya 调用失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
