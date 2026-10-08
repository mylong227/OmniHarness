/**
 * Laya 常驻推理进程（热路径）：`laya_infer.py --serve` + JSONL over stdio。
 *
 * ## 为什么必须有它（实测数字，不是优化癖）
 *
 * 单发路径每次都要重新 `import torch` + 加载 842MB 权重：本机实测**冷启 62.4s / 暖盘 18–19s**，
 * 而默认超时曾是 30s ⇒ 真实使用中大概率超时并被 fail-open 静默吞掉。常驻后首次 15.9s（含 12.7s 加载）、
 * 其后每次 **约 0.4s**（实测 choice + score 两题合计 412ms）。没有这一层，「复用 Laya」只是纸面接线。
 *
 * ## 存活性管理（父进程不得被子进程挂住）
 *
 * 长驻子进程会**拖住 Node 的事件循环**：空闲时若句柄仍被引用，`omniharness exec` 结束却退不出去。
 * 故这里按需切换引用计数（实测有效：unref 后 Node 在 393ms 内自然退出）：
 * - 有在途请求 ⇒ `ref()`（保证响应送达前不离场）；
 * - 无在途请求 ⇒ `unref()`（父进程想走就走；stdin 关闭后 Python 侧 EOF 自然退出，不留孤儿）。
 *
 * ## fail-open 边界
 *
 * 本类**不抛错**：spawn 失败、请求超时、进程中途退出一律转成 `{ available:false, note }`
 * （决策引擎是质量信号，不是安全边界）；`pending.failAll` 保证进程死亡时在途请求不被永久挂起。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PendingRequests } from '../../util/concurrency/pendingRequests.js';
import type { PendingTimeout } from '../../ports/util/pendingTimeout.js';
import { LayaJsonlFramer } from './layaJsonlFramer.js';
import { LayaProcessLiveness } from './layaProcessLiveness.js';
import { LayaReadyWaiters } from './layaReadyWaiters.js';
import type { LayaBridgeResponse, LayaWireQuestion } from './layaQuestionTranslator.js';

/** 常驻进程配置。 */
export interface LayaWarmWorkerOptions {
  /** Python 解释器路径。 */
  readonly pythonPath: string;
  /** 桥脚本路径（`laya_infer.py`）。 */
  readonly scriptPath: string;
  /** 权重目录（空串 = 走在线 Router）。 */
  readonly modelDir: string;
  /** checkpoint repo（在线路径用）。 */
  readonly repo: string;
  /** HuggingFace 镜像端点。 */
  readonly hfEndpoint: string;
  /** 探测预算（毫秒）：仅用于 `import laya` 探测帧——“未就绪时的决策”已改为**不等待**（见 {@link decide}）。 */
  readonly warmupWaitMs: number;
  /** 权重加载预算（毫秒）：`warmup` 帧的上限。**必须有界**（见 {@link preload} 的注释）。 */
  readonly loadTimeoutMs: number;
  /** 热路径单次请求上限（毫秒）：权重已加载后使用（实测 0.4–1.3s，留足余量）。 */
  readonly requestTimeoutMs: number;
  /** 空转回收（毫秒）：这段时间没有任何请求即关掉子进程、释放内存；下次请求自动重启。 */
  readonly idleShutdownMs: number;
}

/** 一次推理请求（引擎组装的入参）。 */
export interface LayaWarmInference {
  /** 待判断状态文本。 */
  readonly state: string;
  /** 线格式问题集。 */
  readonly questions: Readonly<Record<string, LayaWireQuestion>>;
  /** checkpoint repo。 */
  readonly repo: string;
  /** 权重目录（空串 = 在线 Router）。 */
  readonly modelDir: string;
}

/**
 * 常驻 Laya 推理进程：懒启动、请求复用一个已加载权重的 Python 进程。
 */
export class LayaWarmWorker {
  /** 子进程（未启动 / 已回收 / 已死亡时为 undefined，下次请求自动重启）。 */
  private child: ChildProcess | undefined;

  /** stdout 分帧器（JSONL 可能被切成任意片段）。 */
  private readonly framer = new LayaJsonlFramer();

  /** 权重是否已加载完成（收到 `warmup` 或含 `answers` 的帧即置位）。 */
  private ready = false;

  /** 是否已有在途的预加载请求（`preload` 幂等：重复调用不重复投递）。 */
  private loading = false;

  /** 最近一次加载失败的原因（空串 = 无失败）。用于把「仍在加载」与「后端坏了」区分开报。 */
  private loadError = '';

  /** 是否已显式关闭（关闭后不再重启）。 */
  private closed = false;

  /** 空转回收定时器。 */
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  /** 请求 id 自增（帧按 id 关联到 Promise）。 */
  private nextId = 1;

  /** 在途请求登记表（进程退出 / 空转回收时一次性收尾）。 */
  private readonly pending = new PendingRequests<number, LayaBridgeResponse>();

  /** 等待「权重就绪」的等待者集合（就绪 / 回收 / 退出时一次性兑现，避免调用方轮询）。 */
  private readonly readyWaiters = new LayaReadyWaiters();

  /**
   * @param options 进程与预算配置。
   */
  public constructor(private readonly options: LayaWarmWorkerOptions) {}

  /**
   * 权重是否已就绪（就绪后单次请求走短超时）。
   *
   * @returns 已加载完成时为 true。
   */
  public get isReady(): boolean {
    return this.ready;
  }

  /**
   * 是否正在加载权重（`decide` 的跳过原因分类依据：加载中 ⇒ 预期行为；非加载中且未就绪 ⇒ 真故障）。
   *
   * @returns 有在途预加载时为 true。
   */
  public get isLoading(): boolean {
    return this.loading;
  }

  /**
   * 最近一次加载 / 退出失败的原因（空串 = 无）。
   *
   * @returns 失败原因文本。
   */
  public get lastLoadError(): string {
    return this.loadError;
  }

  /**
   * 等待权重加载完成（**不轮询**：就绪帧到达即兑现；进程被回收 / 退出则兑现为 false）。
   *
   * 用途：调用方明确要付「一次冷启动代价」时（如集成测试、交互式启动后想立刻要真信号），
   * 用它替代「反复 decide 直到不 fail-open」。默认路径（自验证回环）**不**调用它——
   * 那条路上未就绪的决策直接跳过（0 延迟），绝不拖住回合。
   *
   * @param timeoutMs 最长等待（毫秒）。
   * @returns 就绪为 true；超时 / 进程被回收为 false。
   */
  public waitReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) {
      return Promise.resolve(true);
    }
    return this.readyWaiters.wait(timeoutMs);
  }

  /**
   * 探测后端（仅 `import laya`，不加载权重；冷启动预算内完成即可）。
   *
   * @returns 桥响应；失败时为 `{ available:false, note }`。
   */
  public async probe(): Promise<LayaBridgeResponse> {
    try {
      return await this.send({ probe: true }, this.options.warmupWaitMs);
    } catch (error) {
      return LayaWarmWorker.failOpen(error);
    }
  }

  /**
   * 后台预加载权重（**不阻塞**、**幂等**）：进程起好后即可并行加载 842MB 权重，
   * 使后续 `decide` 落在热路径上；加载失败只是后续请求 fail-open。
   *
   * @returns 无返回值（结果通过 `isReady` 与后续请求体现）。
   */
  public preload(): void {
    if (this.closed || this.ready || this.loading) {
      return;
    }
    this.loading = true;
    // 注意：**不清空 `loadError`**。它是「上一次加载为什么失败」的凭据，直到真的就绪（onFrame）才作废——
    // 否则「失败 → 立刻重试」这条路上，重试会把原因擦掉，而 `decide` 紧接着又把它读成「仍在加载」
    // （2026-10-07 二轮评审后实测的措辞缺陷）。
    // 解释器本身有问题（路径不存在 / `.bat`、`.cmd` 包装）时**同步**判定并如实上报：
    // `spawn` 的 ENOENT 要等一个事件循环才回来，而 `decide` 会在那之前就报「仍在加载」——
    // 把「配置写错了」误导成「稍等就好」（2026-10-07 评审后实测）。
    const problem = this.interpreterProblem();
    if (problem.length > 0) {
      this.loading = false;
      this.loadError = problem;
      return;
    }
    // **必须带超时**（2026-10-07 评审抓到的回归）：早先为了躲开「15s 请求预算卡住 24s 加载」而改成
    // 无超时，结果造出一个永久卡死态——子进程活着但永不回 warmup 帧时，`loading` 永远为真
    // （`preload` 因此永不重投）、`loadError` 永远为空（每个 decide 都报「仍在加载」），
    // 而且那个在途帧会**ref 住父进程事件循环**，连 CLI 都退不出去。现在用专门的加载预算。
    void this.send(
      {
        warmup: true,
        ...(this.options.modelDir.length > 0 ? { modelDir: this.options.modelDir } : {}),
      },
      this.options.loadTimeoutMs,
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // 加载失败（含超时）即回收该进程：留着一个卡死的进程，下一次 preload 只会再卡一次。
      // 注意顺序——回收会清空 loadError，故原因在其后写入。
      this.shutdownChild();
      this.loadError = message;
    });
  }

  /**
   * 解释器配置本身的问题（空串 = 没问题）。
   *
   * 覆盖两类「同步可判定但异步才报」的配置错误：
   * - 显式给了带分隔符的路径却不存在（裸命令名交给 PATH，无法同步判定）；
   * - Windows 上指向 `.bat` / `.cmd` 包装：常驻模式靠 **stdin 管道**送协议帧，而经 `shell: true`
   *   起的 `cmd.exe` **不会**把 stdin 转发给子进程（评审实测：Python 立刻 EOF 退出，表现成
   *   「热进程已退出」这种与真实原因无关的 note）。故这里**明确拒绝**并给出可执行建议，
   *   而不是留一条静默降级的路径。
   *
   * @returns 问题描述；无问题时为空串。
   */
  private interpreterProblem(): string {
    const path = this.options.pythonPath;
    if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(path)) {
      return `不支持 .bat/.cmd 解释器包装（常驻模式靠 stdin 管道送协议帧，cmd.exe 不转发）：请指向 python.exe（${path}）`;
    }
    const looksLikePath = path.includes('/') || path.includes('\\');
    if (looksLikePath && !existsSync(path)) {
      return `解释器不存在：${path}`;
    }
    return '';
  }

  /**
   * 执行一次类型化决策。
   *
   * **冷启动窗口（权重未就绪）直接返回 fail-open，不排队推理**（2026-10-07 实测订正）：
   * 早先的实现会带着 1.5s 预算把请求投出去，超时后该请求仍留在 Python 队列里被**无人读取地**
   * 执行——既白烧 CPU，又把「就绪」时刻往后推（实测连续 3 次冷请求把就绪从 ~13s 拖到 ~20s，
   * 且每次都让回合白等 1.5s）。现在的口径：未就绪 ⇒ 触发/维持预加载 + **立即**返回（0 延迟），
   * 就绪后走 `requestTimeoutMs`（实测 0.4–1.3s）。
   *
   * @param input 推理请求（状态 / 问题 / repo / 权重目录）。
   * @returns 桥响应；失败 / 冷启动跳过时为 `{ available:false, note }`。
   */
  public async decide(input: LayaWarmInference): Promise<LayaBridgeResponse> {
    if (this.closed) {
      return { available: false, note: 'Laya 热进程已关闭（不重启）' };
    }
    if (!this.ready) {
      this.preload();
      // 区分「正在加载」（预期，稍后就好）与「加载已失败」（解释器/脚本/依赖真的有问题）——
      // 两者混为一谈会让人按「等一会儿」去排查一个永远不会好的故障（2026-10-07 评审发现）。
      return {
        available: false,
        note:
          this.loadError.length > 0
            ? `Laya 热进程不可用：${this.loadError}`
            : '热进程仍在加载权重（本次决策跳过；加载继续在后台进行）',
      };
    }
    try {
      return await this.send(
        {
          repo: input.repo,
          ...(input.modelDir.length > 0 ? { modelDir: input.modelDir } : {}),
          request: { state: input.state, questions: input.questions },
        },
        this.options.requestTimeoutMs,
      );
    } catch (error) {
      return LayaWarmWorker.failOpen(error);
    }
  }

  /**
   * 关闭常驻进程（测试 / 进程收尾用）；关闭后不再重启。
   *
   * @returns 无返回值。
   */
  public dispose(): void {
    this.closed = true;
    this.shutdownChild();
  }

  /**
   * 发送一帧请求并等待同 id 响应。
   *
   * @param payload 请求体（自动补 `id`）。
   * @param timeoutMs 本帧超时预算；**缺省表示不设超时**（只用于 fire-and-forget 的 `warmup` 帧：
   *   权重加载实测 12.7–24s，用请求预算去卡它只会制造「假失败」告警与就绪抖动；帧到达 / 进程退出
   *   仍是它的收尾通道，故不会永久挂起）。
   * @returns 响应帧。
   * @throws Error 进程不可用 / 写入失败 / 超时 / 进程退出时抛出（调用方决定 fail-open）。
   */
  private send(
    payload: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<LayaBridgeResponse> {
    if (this.closed) {
      return Promise.reject(new Error('热进程已关闭'));
    }
    try {
      this.ensureChild();
    } catch (error) {
      return Promise.reject(error);
    }
    const child = this.child;
    if (child?.stdin === undefined || child.stdin === null) {
      return Promise.reject(new Error('热进程 stdin 不可用'));
    }
    const id = this.nextId;
    this.nextId += 1;
    // 有在途请求即拖住父进程（保证响应送达前事件循环不离场）。
    LayaProcessLiveness.set(this.child, true);
    return new Promise<LayaBridgeResponse>((resolve, reject) => {
      const timeout: PendingTimeout<LayaBridgeResponse> | undefined =
        timeoutMs === undefined
          ? undefined
          : {
              ms: timeoutMs,
              onTimeout: (handlers) =>
                handlers.reject?.(new Error(`等待热进程响应超时（${timeoutMs}ms）`)),
            };
      this.pending.register(id, { resolve, reject }, timeout);
      child.stdin?.write(`${JSON.stringify({ ...payload, id })}\n`, (error) => {
        if (error !== undefined && error !== null) {
          this.pending.fail(id, error);
        }
      });
    });
  }

  /**
   * 确保子进程存在（懒启动；已死亡则重启）。
   *
   * **回调必须带子进程身份校验**（2026-10-07 评审发现）：`exit`/`error` 回调可能在「该子进程已被
   * 回收、新的子进程已就绪」之后才被事件循环派发；若无条件执行 {@link onExit}，它会清掉**新**进程的
   * `ready`、冲掉分帧缓冲（把一个 JSONL 帧截成半截）并失败新进程的在途请求——表现为随机 fail-open
   * 且「明明已热却拿到跳过」。
   *
   * @returns 无返回值。
   * @throws Error spawn 立即失败（如解释器不存在）时抛出。
   */
  private ensureChild(): void {
    if (this.child !== undefined) {
      return;
    }
    const child = spawn(this.options.pythonPath, [this.options.scriptPath, '--serve'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      env: { ...process.env, HF_ENDPOINT: this.options.hfEndpoint },
    });
    this.child = child;
    this.framer.reset();
    this.ready = false;
    child.stdout?.on('data', (chunk: Buffer) =>
      this.framer.feed(chunk, (line) => this.onFrame(line)),
    );
    // 断开竞态下的 EPIPE 属正常现象，不上抛（stdin 写回调里另有结构化失败通道）。
    child.stdin?.on('error', () => undefined);
    child.stdout?.on('error', () => undefined);
    child.on('exit', () => this.onExit(new Error('热进程已退出'), child));
    child.on('error', (error: Error) => this.onExit(error, child));
    LayaProcessLiveness.set(this.child, false);
    this.scheduleIdle();
  }

  /**
   * 处理一帧响应：置就绪位、兑现同 id 请求、刷新空转计时与存活性。
   *
   * @param line 单行 JSON。
   * @returns 无返回值。
   */
  private onFrame(line: string): void {
    let message: LayaBridgeResponse;
    try {
      message = JSON.parse(line) as LayaBridgeResponse;
    } catch {
      return;
    }
    if (message.warmup === true || message.answers !== undefined) {
      if (!this.ready) {
        this.ready = true;
        this.loading = false;
        this.loadError = ''; // 真的就绪了，上一次失败的原因作废。
        this.readyWaiters.settle(true);
      }
    }
    if (typeof message.id === 'number') {
      this.pending.settle(message.id, message);
    }
    LayaProcessLiveness.set(this.child, this.pending.size() > 0);
    this.scheduleIdle();
  }

  /**
   * 子进程退出 / spawn 失败：复位句柄、失败全部在途请求（防 Promise 永久挂起）。
   *
   * @param error 退出 / 失败原因。
   * @param source 触发本回调的子进程（**身份校验**：迟到的旧进程事件不得清掉新进程的状态）。
   * @returns 无返回值。
   */
  private onExit(error: Error, source?: ChildProcess): void {
    if (source !== undefined && this.child !== undefined && this.child !== source) {
      return; // 旧进程的迟到事件：忽略，避免污染当前进程状态。
    }
    if (this.child === undefined && !this.loading) {
      return; // 已被主动回收（空闲回收 / dispose）：迟到事件不再改状态。
    }
    this.child = undefined;
    this.framer.reset();
    this.ready = false;
    this.loading = false;
    if (this.loadError.length === 0) {
      // 记住真实原因：否则 `decide` 只能报「仍在加载权重」，把「解释器坏了」误导成「稍后就好」。
      this.loadError = error.message;
    }
    this.readyWaiters.settle(false);
    this.pending.failAll(error);
    this.clearIdle();
  }

  /**
   * 空转回收：无在途请求且空闲达 `idleShutdownMs` 时关掉子进程、释放内存。
   *
   * @returns 无返回值。
   */
  private scheduleIdle(): void {
    this.clearIdle();
    if (this.closed || this.child === undefined || this.pending.size() > 0) {
      return;
    }
    this.idleTimer = setTimeout(() => this.shutdownChild(), this.options.idleShutdownMs);
    // 空转回收定时器不得拖住父进程退出。
    this.idleTimer.unref?.();
  }

  /**
   * 清掉空转定时器。
   *
   * @returns 无返回值。
   */
  private clearIdle(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /**
   * 关闭并复位子进程（空转回收 / dispose 共用；下次请求会重新拉起）。
   *
   * @returns 无返回值。
   */
  private shutdownChild(): void {
    this.clearIdle();
    const child = this.child;
    this.child = undefined;
    this.framer.reset();
    this.ready = false;
    this.loading = false;
    this.loadError = '';
    this.readyWaiters.settle(false);
    this.pending.failAll(new Error('热进程已回收'));
    if (child === undefined) {
      return;
    }
    // 主动回收**不摘监听**（2026-10-07 实测订正）：`ChildProcess` 的 `'error'` 若没有监听者，
    // Node 会把它抛成 **uncaughtException**（实测表现：spawn ENOENT 的迟到 error 让整个测试进程
    // 之外再冒一个未捕获异常）。迟到事件由 `onExit` 的**身份校验**兜住即可。
    // 关 stdin 让 Python 侧 EOF 后自然退出，再兜底 kill。
    child.stdin?.end();
    // spawn 从未成功（ENOENT）时 `pid` 为 undefined，此时 `kill()` 抛 EINVAL。
    if (child.pid !== undefined) {
      try {
        child.kill();
      } catch {
        /* 进程已在退出竞态中消失：回收的目的已达成，不因 kill 失败而中断。 */
      }
    }
  }

  /**
   * 把错误整理成 fail-open 响应。
   *
   * @param error 捕获到的错误。
   * @returns `{ available:false, note }`。
   */
  private static failOpen(error: unknown): LayaBridgeResponse {
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, note: `Laya 热进程不可用：${message}` };
  }
}
