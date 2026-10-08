/**
 * Laya 决策引擎适配器（本地 System-1 推理）：把「类型化决策（`noul` / `choice` / `score`）」
 * 接到本地 `laya` Python 后端上，供自验证回环等高频判断点复用，替代 LLM 长推理。
 *
 * ## 三条链路（本文件是编排者，传输细节在同伴文件里）
 *
 * - `layaPaths`：**零配置**解析解释器与权重目录（显式 → 环境变量 → 项目内 venv/权重 → 兜底）。
 * - `layaWarmWorker`：常驻热进程（`--serve`），一次加载多次前向——实测单次 18–62s → **约 0.4s**。
 * - `layaOneShotBridge`：一次性子进程后路（`warm:false` 或热进程不可用时）。
 *
 * ## 曾经的失败形态（为什么这些默认值长这样）
 *
 * 2026-10 实测：`decisionEngine.mode` 从未被任何配置源打开、解释器默认值是系统 `python3`
 * （本机 3.14.8，无 laya/torch），而 `THIRD_PARTY_ASSETS.md` 却宣称「默认指向项目内 venv」——
 * 于是 1.7GB 的 venv + 权重在运行时**零调用**，且因全程 fail-open 而毫无告警。现在：
 * ① 解析顺序由 `LayaPaths` 单点决定并可被单测锁死；② 每次探测结果落一条结构化日志
 * （可用 info / 不可用 **warn**），使「装了但没生效」不再无声；③ 生产入口默认 `shadow`（见 CLI 层）。
 *
 * ## fail-open（不变的安全取向）
 *
 * Python 不可用 / 未装 laya / 调用失败 / 超时 ⇒ `decide` 返回 `{ available:false }`，不抛错、
 * 不阻断主流程（决策引擎是质量信号，非安全边界）。
 *
 * @maturity L2 — 本地 `laya` 后端（torch 2.14 CPU + 421M 权重）端到端真跑验证：冷启动加载 12.7s、
 *   热路径单次约 0.4s（noul/choice/score 三原语均有真实数值，见看板「Laya 接线修复」一节）。
 * @maturityEvidence tests/unit/decisionEngine.test.ts, tests/unit/layaWiring.test.ts, tests/unit/layaWarmWorker.test.ts, tests/unit/layaPaths.test.ts, tests/unit/selfVerifyVerdictProbe.test.ts, tests/integration/layaBackend.test.ts
 */
import { log } from '../../util/logger.js';
import type {
  DecisionEngine,
  DecisionRequest,
  DecisionResponse,
} from '../../ports/decision/decisionEngine.js';
import {
  LayaEngineConfig,
  type LayaDecisionEngineOptions,
  type LayaEngineResolution,
} from './layaEngineConfig.js';
import {
  LayaQuestionTranslator,
  type LayaBridgeResponse,
  type LayaWireQuestion,
} from './layaQuestionTranslator.js';
import { LayaOneShotBridge } from './layaOneShotBridge.js';
import { LayaWarmWorker } from './layaWarmWorker.js';

export type { LayaDecisionEngineOptions, LayaEngineResolution } from './layaEngineConfig.js';

/**
 * Laya 决策引擎：本地 Python `laya` 包桥的编排者（热进程优先、单发回退、全程 fail-open）。
 *
 * 配置解析与各档预算住在 {@link LayaEngineConfig}（纯「选项 → 快照」）；本类只管生命周期与编排。
 */
export class LayaDecisionEngine implements DecisionEngine {
  /** 端口名。 */
  public readonly name = 'laya';

  /** 解析后的配置快照（解释器 / 权重 / 预算）。 */
  private readonly cfg: LayaEngineConfig;

  /** 常驻热进程（懒构造；`warm:false` 时恒为 undefined）。 */
  private worker: LayaWarmWorker | undefined;

  /** 单发桥（后路）。 */
  private readonly oneShot: LayaOneShotBridge;

  /** 可用性探测结果缓存（undefined = 尚未探测）。 */
  private availability: boolean | undefined = undefined;

  /** 上次探测时刻（负结果按 `availabilityRetryMs` 过期后重探；正结果不受影响）。 */
  private availabilityCheckedAt = 0;

  /** 不可用原因（探测失败时记录，用于 fail-open 说明与告警）。 */
  private availabilityNote = '';

  /** 是否已落过一次解析日志（避免每回合重复刷屏）。 */
  private logged = false;

  /** 是否已落过「冷启动窗口内跳过」告警（避免加载期间每个决策都刷一条）。 */
  private coldSkipLogged = false;

  /** 是否已落过「真失败」告警（冷启动之外的失败；改前这一支完全不落日志）。 */
  private failureLogged = false;

  /**
   * @param options 适配器配置（全部可选，缺省即零配置：项目内 venv + 权重 + 热进程）；
   *   也接受已解析好的 {@link LayaEngineConfig}（测试与嵌入方复用同一份快照时用）。
   */
  public constructor(options: LayaDecisionEngineOptions | LayaEngineConfig = {}) {
    this.cfg = options instanceof LayaEngineConfig ? options : LayaEngineConfig.resolve(options);
    this.oneShot = new LayaOneShotBridge({
      pythonPath: this.cfg.pythonPath,
      scriptPath: this.cfg.scriptPath,
      timeoutMs: this.cfg.timeoutMs,
      hfEndpoint: this.cfg.hfEndpoint,
    });
  }

  /**
   * 解析结果（解释器 / 脚本 / 权重目录 / 预算）——供诊断日志与单测断言。
   *
   * @returns 解析结果快照。
   */
  public resolution(): LayaEngineResolution {
    return this.cfg.resolution();
  }

  /**
   * 探测后端是否可用（`import laya`，不加载权重、不触网）。首次探测触发后台预加载。
   *
   * ## 缓存口径（2026-10-07 评审订正）
   *
   * - **可用** ⇒ 永久缓存（后端不会自己消失；进程退出由热进程自己兜）。
   * - **不可用** ⇒ 只缓存 `availabilityRetryMs`（默认 60s）后自动重探。
   *   此前无条件永久缓存 `false`：一次探测超时（探测预算 1.5s，而本机实测端到端探测
   *   0.58–0.71s，冷启可到 1.65s ⇒ 余量只有约 2×）就会把整个进程的 Laya 判死——
   *   连 `warmUp()` 都救不回来，且没有任何用户面开关能复位它。
   *
   * @returns 可用时为 true。
   */
  public async isAvailable(): Promise<boolean> {
    if (this.availability !== undefined) {
      if (this.availability || !this.negativeCacheExpired()) {
        return this.availability;
      }
    }
    const response = await this.backendProbe();
    this.availability = response.available === true;
    this.availabilityNote = response.note ?? '';
    this.availabilityCheckedAt = Date.now();
    this.logResolution();
    return this.availability;
  }

  /**
   * 负结果缓存是否已过期（可重探）。
   *
   * @returns 可重探时为 true。
   */
  private negativeCacheExpired(): boolean {
    return Date.now() - this.availabilityCheckedAt >= this.cfg.availabilityRetryMs;
  }

  /**
   * 预热后端：启动（或复用）常驻热进程并**等到权重就绪**。
   *
   * 默认路径（自验证回环）不调用它——那条路上的预算是 `warmupWaitMs`，超时即 fail-open，
   * 绝不把回合拖住。本方法供「明确愿意付一次冷启动代价」的调用方使用：交互式启动后想立刻
   * 拿到真信号、或端到端验证热路径时，用它替代「反复 decide 直到不 fail-open」。
   *
   * @param timeoutMs 最长等待（毫秒，默认 300000：本机实测加载 12.7s，留足冷盘余量）。
   * @returns 就绪为 true；`warm:false` 或超时 / 进程不可用为 false。
   */
  public async warmUp(timeoutMs = 300_000): Promise<boolean> {
    if (!this.cfg.warm) {
      return false;
    }
    const worker = this.ensureWorker();
    worker.preload();
    return worker.waitReady(timeoutMs);
  }

  /**
   * 单次类型化决策。
   *
   * 后端不可用 / 调用失败 / 超时一律返回 `{ available:false }`（fail-open，不抛错）。
   *
   * @param request 决策请求（state + 问题集）。
   * @returns 决策响应。
   */
  public async decide(request: DecisionRequest): Promise<DecisionResponse> {
    if (!(await this.isAvailable())) {
      return { answers: {}, available: false, note: this.unavailableNote() };
    }
    const questions = LayaQuestionTranslator.toWireQuestions(request.questions);
    const response = await this.runInference(request.state, questions);
    if (response.available !== true) {
      this.logDecideFailure(response.note ?? '');
      return { answers: {}, available: false, note: response.note ?? 'laya 决策失败（fail-open）' };
    }
    return {
      answers: response.answers ?? {},
      available: true,
      ...(response.model !== undefined ? { model: response.model } : {}),
    };
  }

  /**
   * 关闭常驻进程（测试 / 收尾用）。关闭后 `decide` 仍在可用时重新拉起（除非进程被显式回收）。
   *
   * @returns 无返回值。
   */
  public dispose(): void {
    this.worker?.dispose();
    this.worker = undefined;
  }

  /**
   * 取（必要时构造）常驻热进程。
   *
   * @returns 热进程实例。
   */
  private ensureWorker(): LayaWarmWorker {
    this.worker ??= new LayaWarmWorker({
      pythonPath: this.cfg.pythonPath,
      scriptPath: this.cfg.scriptPath,
      modelDir: this.cfg.modelDir,
      repo: this.cfg.repo,
      hfEndpoint: this.cfg.hfEndpoint,
      warmupWaitMs: this.cfg.warmupWaitMs,
      // 热路径预算取两者较小者：`timeoutMs` 是用户可配的「单次决策上限」，
      // 若它比热路径默认值更小就应当生效（否则「调了超时没用」＝又一处声明未接线）。
      requestTimeoutMs: Math.min(this.cfg.requestTimeoutMs, this.cfg.timeoutMs),
      loadTimeoutMs: this.cfg.loadTimeoutMs,
      idleShutdownMs: this.cfg.idleShutdownMs,
    });
    return this.worker;
  }

  /**
   * 探测后端（热路径用热进程；`warm:false` 用单发桥），并在可用时触发后台预加载。
   *
   * @returns 桥响应（失败时为 `{ available:false, note }`，不抛错）。
   */
  private async backendProbe(): Promise<LayaBridgeResponse> {
    if (!this.cfg.warm) {
      try {
        return await this.oneShot.request({ repo: this.cfg.repo, probe: true });
      } catch (error) {
        return { available: false, note: LayaDecisionEngine.message(error) };
      }
    }
    const worker = this.ensureWorker();
    const response = await worker.probe();
    if (response.available === true) {
      // 探测通过即并行加载权重：把 12.7s 的加载摊到 agent 干活的这段时间里，
      // 使后续 decide 落在热路径（实测约 0.4s）而不是被冷启动预算截断。
      worker.preload();
    }
    return response;
  }

  /**
   * 执行一次推理（热路径优先；`warm:false` 走单发桥）。
   *
   * @param state 待判断状态文本。
   * @param questions 线格式问题集。
   * @returns 桥响应（失败时为 `{ available:false, note }`，不抛错）。
   */
  private async runInference(
    state: string,
    questions: Readonly<Record<string, LayaWireQuestion>>,
  ): Promise<LayaBridgeResponse> {
    if (this.cfg.warm) {
      return this.ensureWorker().decide({
        state,
        questions,
        repo: this.cfg.repo,
        modelDir: this.cfg.modelDir,
      });
    }
    try {
      return await this.oneShot.request({
        repo: this.cfg.repo,
        ...(this.cfg.modelDir.length > 0 ? { modelDir: this.cfg.modelDir } : {}),
        request: { state, questions },
      });
    } catch (error) {
      return { available: false, note: LayaDecisionEngine.message(error) };
    }
  }

  /**
   * 决策失败 / 冷启动跳过各落一场 warn（每类**只落一次**，避免刷屏）。
   *
   * 为什么必须有：fail-open 是本模块的既定取向，但**静默的 fail-open 就是缺陷的温床**——
   * 2026-10 的实测缺陷正是「引擎装了却零调用，而没有任何一行日志」。两类原因要分开报，
   * 因为处置完全不同：
   * - **冷启动跳过**：权重还在加载（实测 12.7–24s），属设计内的预期行为，重试即可
   *   （判据是热进程 `isLoading`，而**不是**「未就绪」——加载已经失败也表现为未就绪，
   *   把它归到「稍后就好」会让人白等一个永远不会好的故障）；
   * - **真失败**：推理报错 / 超时 / 进程崩溃 / 加载失败，需要人看（改前这一支完全不落日志）。
   *
   * @param note 桥返回的原因。
   * @returns 无返回值。
   */
  private logDecideFailure(note: string): void {
    if (this.cfg.warm && this.worker?.isLoading === true) {
      if (this.coldSkipLogged) {
        return;
      }
      this.coldSkipLogged = true;
      log.warn('Laya 热进程仍在加载权重，本次决策跳过（fail-open；加载继续在后台进行）', {
        engine: this.name,
        warmupWaitMs: this.cfg.warmupWaitMs,
        note,
      });
      return;
    }
    if (this.failureLogged) {
      return;
    }
    this.failureLogged = true;
    log.warn('Laya 决策失败（fail-open：本次降级为无预判，不影响主流程）', {
      engine: this.name,
      warm: this.cfg.warm,
      note,
    });
  }

  /**
   * 落一次后端解析日志（可用 info / 不可用 warn），让「装了但没生效」在日志里可见。
   *
   * @returns 无返回值。
   */
  private logResolution(): void {
    if (this.logged) {
      return;
    }
    this.logged = true;
    const fields = {
      engine: this.name,
      pythonPath: this.cfg.pythonPath,
      scriptPath: this.cfg.scriptPath,
      modelDir: this.cfg.modelDir,
      warm: this.cfg.warm,
      available: this.availability === true,
      ...(this.availabilityNote.length > 0 ? { note: this.availabilityNote } : {}),
    };
    if (this.availability === true) {
      log.info('Laya 决策引擎后端已就绪', fields);
    } else {
      log.warn('Laya 决策引擎后端不可用（fail-open，决策将回落到 LLM）', fields);
    }
  }

  /**
   * 构造 fail-open 说明（保留历史前缀，便于既有日志检索）。
   *
   * @returns 说明文本。
   */
  private unavailableNote(): string {
    return this.availabilityNote.length > 0
      ? `laya 后端不可用（fail-open）：${this.availabilityNote}`
      : 'laya 后端不可用（fail-open）';
  }

  /**
   * 把任意错误整理成一句可读原因。
   *
   * @param error 捕获到的错误。
   * @returns 原因文本。
   */
  private static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
