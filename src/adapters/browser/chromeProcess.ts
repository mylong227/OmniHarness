/**
 * Chromium 子进程生命周期管理：启动、解析调试端点、结束（含杀进程树）。
 *
 * ## 为什么不用固定端口
 *
 * 固定 `--remote-debugging-port=9222` 在并发下必然 `EADDRINUSE`（本仓会同时跑多个
 * 会话/测试）。改用 `--remote-debugging-port=0` 让浏览器自己挑一个空闲端口。
 *
 * ## 端点从哪来（2026-09-27 实测更正：stderr 在 Windows 上**不可用**）
 *
 * 首选**读 `--user-data-dir` 下的 `DevToolsActivePort` 文件**（自选端口模式下 Chromium 自己写的
 * 端点声明；与官方 `chrome-launcher` 同一做法），stderr 的 `DevTools listening on ws://…` 仅作
 * 快路径保留。原因（本机 Chrome 154.0.8037.58 / Windows 逐条实测）：
 *  - `spawn(chrome.exe, …)` 拿到的 pid 是**启动器 stub**：它把真浏览器拉起后**立刻以 code=0 退出**
 *    （实测 `child.exitCode === 0`），而真浏览器的 stderr **不接到我们这条管道**——实测 stderr
 *    零字节、且全文**不含** `DevTools listening on`。
 *  - 于是旧实现（只等 stderr 那一行）把「启动器正常交接」读成「浏览器进程提前退出（code=0）」，
 *    真机截图**必然失败**并甩出一句误导性结论；同期 `DevToolsActivePort` 已写出
 *    `"18818\n/devtools/browser/<uuid>"`，据此拼出的浏览器级 ws 端点与 `/json/version`
 *    返回的 `webSocketDebuggerUrl` **逐字相同**（已实测）。
 *  - 同一条实测还揭示：**只 kill 启动器什么都杀不掉**（真浏览器 + 9 个 `--type=*` 子进程全部留下），
 *    故 {@link ChromeProcess.kill} 在 Windows 上按唯一 user-data-dir 扫出真浏览器再整树终止。
 *
 * ## 为什么单独一个类
 *
 * 这一层全是「进程 + 流 + 定时器」的平台细节，与协议语义无关；
 * 混进 `BrowserSession` 会让那个类既管 CDP 又管进程，也更容易漏掉清理路径
 * ——「泄漏一个浏览器进程」是这类功能最典型的线上事故。
 */
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { ProcessTreeKiller } from '../tool/shell/processTreeKiller.js';

/** 本类启动的子进程形态：stdin 忽略、stdout/stderr 为管道。 */
type ChromeChild = ChildProcessByStdio<null, Readable, Readable>;

/** 启动结果。 */
export interface ChromeLaunchResult {
  /** DevTools 浏览器级 WebSocket 端点。 */
  readonly webSocketUrl: string;
  /** 调试端口（从端点反解，供 `/json/version` 使用）。 */
  readonly port: number;
}

/** 启动选项。 */
export interface ChromeProcessOptions {
  /** 可执行文件绝对路径。 */
  readonly executable: string;
  /** 用户数据目录（必须是本进程独占的临时目录，避免污染用户配置或互相串味）。 */
  readonly userDataDir: string;
  /** 额外命令行参数（会拼在内置参数之后）。 */
  readonly extraArgs?: readonly string[] | undefined;
  /** 等待 DevTools 端点就绪的超时毫秒数（默认 30s）。 */
  readonly launchTimeoutMs?: number | undefined;
}

/** 本类内置的启动参数（与 `web/test/browserHarness.mjs` 的 E1 路线保持同源）。 */
const BASE_ARGS = [
  '--headless=new',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-proxy-server',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-crash-reporter',
  '--disable-breakpad',
  '--remote-debugging-port=0',
] as const;

/** stderr 上那行端点声明的匹配式（快路径；Windows 上实测**收不到**，见模块头）。 */
const DEVTOOLS_LINE = /DevTools listening on (ws:\/\/\S+)/;

/** 自选端口模式下 Chromium 在 user-data-dir 里写下的端点声明文件。 */
const ACTIVE_PORT_FILE = 'DevToolsActivePort';

/** 端点轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 100;

/**
 * 启动器退出后的**宽限**（毫秒）。
 *
 * Windows 上启动器交接完就退（code=0），而真浏览器还要几百毫秒才写 `DevToolsActivePort`
 * ⇒ 「子进程退出」**不能**立刻判死。宽限内拿到端点即算成功；仍拿不到才报失败
 * （POSIX 上真浏览器就是子进程本身，退出即真死，但同样只多等这么一次，代价可忽略）。
 */
const EXIT_GRACE_MS = 2_000;

/**
 * Chromium 子进程句柄：启动一次、用完必须 {@link ChromeProcess.kill}。
 */
export class ChromeProcess {
  /** 默认等待端点就绪的超时。 */
  public static readonly DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;

  /** 子进程句柄（启动后才有值）。 */
  private child: ChromeChild | undefined;

  /** stderr 累积缓冲（端点那行可能被分帧截断，必须按行缓冲）。 */
  private stderrBuffer = '';

  /** 启动期间暂存的 stderr（端点未出现时用于报错，便于定位「为什么起不来」）。 */
  private readonly stderrTail: string[] = [];

  /** 已就绪的启动结果（幂等）。 */
  private launched: ChromeLaunchResult | undefined;

  /** 是否已结束。 */
  private killed = false;

  public constructor(private readonly options: ChromeProcessOptions) {}

  /**
   * 启动浏览器并等待 DevTools 端点就绪。
   *
   * @returns 端点信息。
   */
  public async launch(): Promise<ChromeLaunchResult> {
    if (this.launched !== undefined) {
      return this.launched;
    }
    if (this.child !== undefined) {
      throw new Error('浏览器已在启动中');
    }
    const args = [
      ...BASE_ARGS,
      `--user-data-dir=${this.options.userDataDir}`,
      ...(this.options.extraArgs ?? []),
      'about:blank',
    ];
    const child = spawn(this.options.executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let result: ChromeLaunchResult;
    try {
      result = await this.awaitDevToolsUrl(child);
    } catch (error) {
      // 启动失败（超时 / 提前退出）必须**就地回收**：否则 Chromium 子进程成为孤儿、stdio 管道
      // 仍被引用（把宿主钉住不退出）、且 `this.child` 不复位 ⇒ 之后每次 launch() 都抛
      // 「浏览器已在启动中」，而 `process.once('exit')` 兜底钩子此时**还没注册**。
      this.kill();
      throw error;
    }
    this.launched = result;
    ChromeProcess.detach(child);
    // 进程退出钩子：`unref` 之后 Node 可以正常退出，但那样浏览器会被抛在后台成为孤儿。
    // 两件事必须**成对**出现——只 unref 会漏进程，只挂钩子会让 CLI 永远不退出。
    process.once('exit', () => this.kill());
    return result;
  }

  /**
   * 结束浏览器进程；幂等。
   *
   * **Windows 上必须按 user-data-dir 扫**：`this.child` 是启动器 stub，`child.kill()` 只终结它
   * （且它通常早已退出）——真浏览器与其 `--type=renderer|gpu-process|…` 子进程会**全部留下**
   * （实测每次会话残留 9–10 个进程，反复截图会堆到几十个 / GB 级内存）。故 ChildProcess 终结之后
   * 再按唯一的 `--user-data-dir` 标记扫出真浏览器，逐个整树终止（{@link ProcessTreeKiller.killPid}）。
   * 顺序是刻意的：先轻（`child.kill`）后重（枚举 + taskkill /T），且全部**尽力而为**——清理失败
   * 不该毁掉已经拿到的截图结果。
   *
   * POSIX 不做扫描：那里没有启动器交接，`child.kill()` 打的就是真浏览器，Chromium 自己收尾子进程。
   *
   * @returns 无返回值。
   */
  public kill(): void {
    if (this.killed) {
      return;
    }
    this.killed = true;
    const child = this.child;
    this.child = undefined;
    if (child !== undefined) {
      try {
        // stdin 是 'ignore'（null），不能碰；stdout/stderr 是管道，主动关掉以释放句柄。
        child.stdout.destroy();
        child.stderr.destroy();
      } catch {
        /* 流可能已关闭 */
      }
      try {
        child.kill();
      } catch {
        /* 进程可能已退出 */
      }
    }
    if (process.platform === 'win32') {
      for (const pid of ChromeProcess.browserPidsOf(this.options.userDataDir)) {
        ProcessTreeKiller.killPid(pid);
      }
    }
  }

  /**
   * 等待调试端点就绪：**先轮询 `DevToolsActivePort`**，stderr 那一行只作快路径。
   *
   * 两条信号都要（缺一不可）：
   * - Windows：stderr 收不到端点（启动器把它吞了），只有文件可用；
   * - 其它平台/旧版本：文件可能来不及写或格式变化，stderr 能在几百毫秒内直接给出端点。
   *
   * 「子进程退出」不立即判死：Windows 上那是**正常的启动器交接**（见 {@link EXIT_GRACE_MS}）；
   * 宽限内仍无端点才如实失败，并把 stderr 尾部一起报出来。
   *
   * @param child 子进程。
   * @returns 端点信息。
   */
  private async awaitDevToolsUrl(child: ChromeChild): Promise<ChromeLaunchResult> {
    const timeoutMs = this.options.launchTimeoutMs ?? ChromeProcess.DEFAULT_LAUNCH_TIMEOUT_MS;
    const userDataDir = this.options.userDataDir;
    /** stderr 快路径解析出的端点（一旦拿到即用）。 */
    let fromStderr: ChromeLaunchResult | undefined;
    /** 子进程退出码（undefined = 尚未退出）。 */
    let exitCode: number | null | undefined;
    /** spawn 级错误（可执行文件不存在等）。 */
    let spawnError: Error | undefined;
    const onData = (chunk: Buffer): void => {
      this.stderrBuffer += chunk.toString('utf8');
      const lines = this.stderrBuffer.split(/\r?\n/);
      this.stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        ChromeProcess.keepTail(this.stderrTail, line.trim());
        const match = DEVTOOLS_LINE.exec(line);
        if (match?.[1] === undefined) {
          continue;
        }
        const port = ChromeProcess.portOf(match[1]);
        if (port !== null) {
          fromStderr = { webSocketUrl: match[1], port };
        }
      }
    };
    const onExit = (code: number | null): void => {
      exitCode = code;
    };
    const onError = (error: Error): void => {
      spawnError = error;
    };
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (spawnError !== undefined) {
          throw new Error(`浏览器进程启动失败: ${spawnError.message}`);
        }
        if (fromStderr !== undefined) {
          return fromStderr;
        }
        const fromFile = ChromeProcess.endpointFromActivePort(userDataDir);
        if (fromFile !== null) {
          return fromFile;
        }
        if (exitCode !== undefined) {
          const grace = await ChromeProcess.pollEndpoint(
            userDataDir,
            EXIT_GRACE_MS,
            () => fromStderr,
          );
          if (grace !== null) {
            return grace;
          }
          throw new Error(
            `浏览器进程提前退出（code=${String(exitCode)}）。stderr 尾部：${ChromeProcess.tailOf(this.stderrTail)}`,
          );
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `浏览器未在 ${String(timeoutMs)}ms 内上报 DevTools 端点。stderr 尾部：${ChromeProcess.tailOf(this.stderrTail)}`,
          );
        }
        await ChromeProcess.delay(POLL_INTERVAL_MS);
      }
    } finally {
      child.stderr.removeListener('data', onData);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    }
  }

  /**
   * 短轮询：在宽限窗口内等端点出现（stderr 快路径优先）。
   * @param userDataDir user-data-dir（`DevToolsActivePort` 所在处）。
   * @param graceMs 宽限毫秒数。
   * @param stderrEndpoint 取 stderr 已解析端点的回调（可能始终为 undefined）。
   * @returns 端点；宽限内没等到为 null。
   */
  private static async pollEndpoint(
    userDataDir: string,
    graceMs: number,
    stderrEndpoint: () => ChromeLaunchResult | undefined,
  ): Promise<ChromeLaunchResult | null> {
    const deadline = Date.now() + graceMs;
    for (;;) {
      const quick = stderrEndpoint();
      if (quick !== undefined) {
        return quick;
      }
      const fromFile = ChromeProcess.endpointFromActivePort(userDataDir);
      if (fromFile !== null) {
        return fromFile;
      }
      if (Date.now() >= deadline) {
        return null;
      }
      await ChromeProcess.delay(POLL_INTERVAL_MS);
    }
  }

  /**
   * 从 `DevToolsActivePort` 解析浏览器级 WebSocket 端点。
   *
   * 文件内容两行：`<port>` 与 `/devtools/browser/<uuid>`（实测 Chrome 154；第二行缺失时回落
   * `/devtools/browser`，由调用方在 CDP 连接阶段如实失败）。
   *
   * @param userDataDir user-data-dir。
   * @returns 端点信息；文件未写/内容不合法时为 null（属正常的「还没起来」）。
   */
  private static endpointFromActivePort(userDataDir: string): ChromeLaunchResult | null {
    const file = join(userDataDir, ACTIVE_PORT_FILE);
    if (!existsSync(file)) {
      return null;
    }
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return null; // 正在写/被占用：下一轮再试
    }
    const [portLine, pathLine] = text.split(/\r?\n/);
    const port = Number((portLine ?? '').trim());
    if (!Number.isInteger(port) || port <= 0) {
      return null;
    }
    const rawPath = (pathLine ?? '').trim();
    const path =
      rawPath === '' ? '/devtools/browser' : rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    return { webSocketUrl: `ws://127.0.0.1:${String(port)}${path}`, port };
  }

  /**
   * 扫出用该 `--user-data-dir` 启动的 Chromium 进程 pid。
   *
   * 为什么按标记扫而不按父链：Windows 上启动器交接后**父链已断**（启动器先死），
   * `taskkill /T` 无从遍历（实测对已退出的父 pid 报 `process not found`）。每个会话的
   * user-data-dir 都是独占临时目录 ⇒ 标记天然唯一。失败返回空数组（收尾路径不抛错）。
   *
   * @param userDataDir user-data-dir（唯一标记）。
   * @returns 命中的 pid 列表。
   */
  private static browserPidsOf(userDataDir: string): number[] {
    try {
      // `wmic` 在新版 Windows 已移除，故用 PowerShell CIM（`--NoProfile` 起得更快）。
      const script =
        'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | ' +
        'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
      const raw = execFileSync('powershell', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
      }).trim();
      if (raw === '') {
        return [];
      }
      const parsed: unknown = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list
        .filter(
          (item): item is { ProcessId: number; CommandLine?: string } =>
            typeof item === 'object' && item !== null,
        )
        .filter((item) => String(item.CommandLine ?? '').includes(userDataDir))
        .map((item) => Number(item.ProcessId))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }

  /** 异步小睡（端点轮询用）。 @param ms 毫秒。 @returns 无返回值 */
  private static async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 让浏览器子进程不再钉住父进程的事件循环。
   *
   * 三件事必须一起做（缺一就会出问题）：
   * - 关掉 stdout 管道（本类从不用它，留着等于给自己多一个 ref 的句柄）；
   * - 关掉 stderr 管道（端点那行已经解析完，不再需要）；
   * - `unref()` 子进程句柄。
   *
   * 只做 `unref()` 而不管 stdio 是不够的——`Readable` 管道只要有监听器/未读完的数据
   * 依然会把事件循环撑住，于是 CLI 跑完这一轮后**永远不退出**。
   *
   * @param child 子进程。
   * @returns 无返回值。
   */
  private static detach(child: ChromeChild): void {
    try {
      child.stdout.destroy();
      child.stderr.destroy();
    } catch {
      /* 流可能已关闭 */
    }
    child.unref();
  }

  /**
   * 从 WebSocket 端点里反解端口。
   *
   * @param url 端点地址（`ws://127.0.0.1:PORT/devtools/browser/<id>`）。
   * @returns 端口号；解析不出为 null。
   */
  private static portOf(url: string): number | null {
    const match = /^ws:\/\/[^/]*?:(\d+)\//.exec(url);
    if (match?.[1] === undefined) {
      return null;
    }
    const port = Number(match[1]);
    return Number.isInteger(port) && port > 0 ? port : null;
  }

  /**
   * 保留 stderr 的最后若干行（用于失败时报出真因，而不是只说「超时」）。
   *
   * @param tail 尾部缓冲。
   * @param line 新行。
   * @returns 无返回值。
   */
  private static keepTail(tail: string[], line: string): void {
    if (line === '') {
      return;
    }
    tail.push(line);
    while (tail.length > 12) {
      tail.shift();
    }
  }

  /**
   * 拼接 stderr 尾部为一行（截断到 800 字符，避免把整个日志塞进错误消息）。
   *
   * @param tail 尾部缓冲。
   * @returns 可读文本；为空时为「(空)」。
   */
  private static tailOf(tail: readonly string[]): string {
    const text = tail.join(' | ');
    return text === '' ? '(空)' : text.slice(-800);
  }
}
