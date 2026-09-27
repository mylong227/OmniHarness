/**
 * 进程级崩溃护栏（2026-09-26 审计 §22.7 第 5 条，2026-09-27 收口）。
 *
 * ## 缺口（为什么必须有它）
 *
 * 全仓此前**零** `process.on('unhandledRejection' | 'uncaughtException')`。Node 22 下这两条默认
 * 都会**终止进程并打裸栈**：用户看到的是堆栈，不是「哪一步失败、怎么办」；服务端/守护进程更是
 * 被一条浮动 rejection 直接带走（`void promise` 在本仓很常见：后台任务、事件桥、插件注册……）。
 * 逐个调用点补 `.catch` 治标不治本——**漏掉的第 N 个**照样能杀进程，故必须在**入口**兜一次。
 *
 * ## 口径（三条，刻意不含糊）
 *
 *  1. `unhandledRejection`：**记录 + 继续运行**（计数）。一条浮动 rejection 不该带走整个会话；
 *     但**不做「继续运行绝对安全」的承诺**——故连续达到 `maxRejections`（默认 5）即升级为致命路径，
 *     避免「无限刷屏式带病运行」。
 *  2. `uncaughtException`：**记录 + 优雅收尾 + 退出码 1**。抛出点之外的栈已不可信，
 *     继续运行等于带着未知损坏改用户的工作区——这类路径必须 fail-closed。
 *  3. `SIGINT` / `SIGTERM`：**记录 + 优雅收尾 + 退出码 130 / 143**（保留既有 `serve`
 *     自带处理器的语义：两者都会跑，重复 `exit` 无副作用）。
 *
 * ## 可测性（为什么不直接碰 `process`）
 *
 * 目标进程以**最小接口**注入（`on` + 可选 `exit`），优雅收尾与日志出口也由调用方给——
 * 于是本类可在单测里对假目标完整验证（含「收尾抛错/悬挂仍必须退出」），而不动真进程。
 *
 * **平台诚实边界**：Windows 上 `process.kill(pid, 'SIGTERM')` 是 `TerminateProcess` 语义，
 * **不触发**监听器（真机冒烟实测：退出码 1、无任何报告）。故信号路径分两半验证——
 * 处理器接线与退出码（130/143）由单测 + 合成 `process.emit('SIGTERM')` 覆盖；
 * OS 投递那一半只在真实 Ctrl-C / POSIX 信号下才走得到，Windows 上无法脚本化复现。
 *
 * @see ./exec.ts —— CLI 入口的唯一接线点（库调用方 import 本模块**不产生任何副作用**）。
 */

/** 不可信失败的结构化报告（日志出口与致命路径共用）。 */
export interface CrashReport {
  /** 失败类别。 */
  readonly kind: 'unhandledRejection' | 'uncaughtException' | 'signal';
  /** 人话描述（含原始 message / 信号名）。 */
  readonly message: string;
  /** 原始堆栈（可用时）。 */
  readonly stack?: string | undefined;
  /** 本次安装以来该类失败的累计次数（1 起）。 */
  readonly count: number;
}

/** 护栏所需的最小进程视图（真进程与测试假目标都满足）。 */
export interface CrashGuardTarget {
  /** 注册监听（返回什么不重要，真进程返回自身）。 */
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  /** 退出（缺省时护栏只报告、不退出——便于测试与嵌入）。 */
  exit?: ((code: number) => void) | undefined;
}

/** 安装依赖。 */
export interface CrashGuardDeps {
  /** 目标进程（生产传 `process`）。 */
  readonly proc: CrashGuardTarget;
  /** 结构化记录出口（生产接 `log.error` / `log.warn`）。 */
  readonly report: (report: CrashReport) => void;
  /** 优雅收尾钩子（关服务器、冲事件、杀子进程）；抛错或悬挂都不阻塞退出。 */
  readonly shutdown?: (() => void | Promise<void>) | undefined;
  /** 收尾宽限（毫秒，默认 3000）：超时即强退，避免「收尾自身挂死导致永远退不出去」。 */
  readonly graceMs?: number | undefined;
  /** 连续浮动 rejection 的容忍上限（默认 5），达标即升级为致命路径。 */
  readonly maxRejections?: number | undefined;
  /** 是否接管 SIGINT / SIGTERM（默认 true；`serve` 已自带处理器，重复接管无副作用）。 */
  readonly signals?: boolean | undefined;
  /** 超时定时器的构造出口（测试可注入，缺省用全局 `setTimeout`）。 */
  readonly timer?: ((fn: () => void, ms: number) => unknown) | undefined;
}

/** 默认的收尾宽限（毫秒）。 */
const DEFAULT_GRACE_MS = 3000;

/** 默认的浮动 rejection 容忍上限。 */
const DEFAULT_MAX_REJECTIONS = 5;

/** 信号名 → 约定退出码（`128 + signal number`）。 */
const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/** 把未知抛出物转成可读文本与堆栈。 */
const describe = (err: unknown): { message: string; stack?: string } => {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  return { message: typeof err === 'string' ? err : JSON.stringify(err) };
};

/**
 * 进程级崩溃护栏（无状态类，安装即返回解绑前的计数视图）。
 *
 * 只做「兜底报告 + 有界收尾 + 退出码」，不含任何业务判断。
 */
export class CrashGuard {
  /**
   * 安装护栏。
   * @param deps 目标进程、报告出口、收尾钩子与宽限/上限。
   * @returns 已安装的护栏状态（各类失败计数可读，供测试与诊断）。
   */
  public static install(deps: CrashGuardDeps): CrashGuard {
    const guard = new CrashGuard(deps);
    guard.attach();
    return guard;
  }

  /** 已观察到的浮动 rejection 数。 */
  private rejections = 0;
  /** 是否已经走上致命路径（收尾只做一次）。 */
  private fatal = false;

  /**
   * @param deps 见 {@link CrashGuardDeps}。
   */
  private constructor(private readonly deps: CrashGuardDeps) {}

  /**
   * 当前浮动 rejection 计数（诊断用）。
   * @returns 本次安装以来观察到的浮动 rejection 条数。
   */
  public get rejectionCount(): number {
    return this.rejections;
  }

  /**
   * 注册四类监听（本方法只做接线，判定全在下面三个私有处理器里）。
   * @returns 无返回值。
   */
  private attach(): void {
    this.deps.proc.on('unhandledRejection', (reason: unknown) => {
      this.onRejection(reason);
    });
    this.deps.proc.on('uncaughtException', (error: unknown) => {
      void this.onException(error);
    });
    if (this.deps.signals !== false) {
      for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
        this.deps.proc.on(signal, () => {
          void this.onSignal(signal);
        });
      }
    }
  }

  /**
   * 浮动 rejection：记录并计数；达上限升级为致命路径。
   * @param reason 拒绝原因（任意类型）。
   * @returns 无返回值。
   */
  private onRejection(reason: unknown): void {
    this.rejections += 1;
    const { message, stack } = describe(reason);
    const limit = this.deps.maxRejections ?? DEFAULT_MAX_REJECTIONS;
    if (this.rejections < limit) {
      this.deps.report({ kind: 'unhandledRejection', message, stack, count: this.rejections });
      return;
    }
    this.deps.report({
      kind: 'unhandledRejection',
      message: `连续 ${String(this.rejections)} 条浮动 rejection（上限 ${String(limit)}）⇒ 按致命处理：${message}`,
      stack,
      count: this.rejections,
    });
    void this.finalize(1);
  }

  /**
   * 未捕获异常：进程状态已不可信 ⇒ 记录后收尾并退出（fail-closed）。
   * @param error 抛出物（任意类型）。
   * @returns 收尾完成的 Promise。
   */
  private async onException(error: unknown): Promise<void> {
    const { message, stack } = describe(error);
    this.deps.report({ kind: 'uncaughtException', message, stack, count: 1 });
    await this.finalize(1);
  }

  /**
   * 终止信号：记录后收尾并按 `128 + n` 退出。
   * @param signal 信号名（`SIGINT` / `SIGTERM`）。
   * @returns 收尾完成的 Promise。
   */
  private async onSignal(signal: string): Promise<void> {
    this.deps.report({
      kind: 'signal',
      message: `收到 ${signal}，开始优雅收尾`,
      count: 1,
    });
    await this.finalize(SIGNAL_EXIT_CODES[signal] ?? 1);
  }

  /**
   * 有界优雅收尾：收尾只做一次；`shutdown` 抛错或超过 `graceMs` 都不阻塞退出。
   * @param code 退出码。
   * @returns 收尾完成的 Promise（无论收尾成功与否都会 resolve）。
   */
  private async finalize(code: number): Promise<void> {
    if (this.fatal) {
      return;
    }
    this.fatal = true;
    const shutdown = this.deps.shutdown;
    if (shutdown !== undefined) {
      await this.raceWithGrace(shutdown);
    }
    this.deps.proc.exit?.(code);
  }

  /**
   * 在宽限内等待收尾钩子；抛错或超时都立即放行（收尾不得阻塞退出）。
   * @param shutdown 收尾钩子。
   * @returns 收尾完成的 Promise。
   */
  private async raceWithGrace(shutdown: () => void | Promise<void>): Promise<void> {
    const graceMs = this.deps.graceMs ?? DEFAULT_GRACE_MS;
    if (graceMs <= 0) {
      await this.swallow(shutdown);
      return;
    }
    // 定时器只是「到点放行」的判据：不清理也不影响正确性——随后的 `exit` 会带走整个事件循环。
    const timer = this.deps.timer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
    await Promise.race([
      this.swallow(shutdown),
      new Promise<void>((resolve) => {
        timer(resolve, graceMs);
      }),
    ]);
  }

  /**
   * 执行收尾钩子并吞掉其失败（收尾失败不得阻塞退出，只记录）。
   * @param shutdown 收尾钩子。
   * @returns 无返回值。
   */
  private async swallow(shutdown: () => void | Promise<void>): Promise<void> {
    try {
      await shutdown();
    } catch (e: unknown) {
      this.deps.report({
        kind: 'signal',
        message: `收尾钩子自身失败（已忽略，照常退出）：${describe(e).message}`,
        count: 1,
      });
    }
  }
}
