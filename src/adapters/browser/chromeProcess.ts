/**
 * Chromium 子进程生命周期管理：启动、从 stderr 读出调试端点、结束（含杀进程树）。
 *
 * ## 为什么不用固定端口
 *
 * 固定 `--remote-debugging-port=9222` 在并发下必然 `EADDRINUSE`（本仓会同时跑多个
 * 会话/测试）。改用 `--remote-debugging-port=0` 让浏览器自己挑一个空闲端口，
 * 再从 stderr 的那行 `DevTools listening on ws://…` 里把**真实**端点读出来。
 *
 * ## 为什么单独一个类
 *
 * 这一层全是「进程 + 流 + 定时器」的平台细节，与协议语义无关；
 * 混进 `BrowserSession` 会让那个类既管 CDP 又管进程，也更容易漏掉清理路径
 * ——「泄漏一个浏览器进程」是这类功能最典型的线上事故。
 */
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

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

/** stderr 上那行端点声明的匹配式。 */
const DEVTOOLS_LINE = /DevTools listening on (ws:\/\/\S+)/;

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
    const result = await this.awaitDevToolsUrl(child);
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
   * Windows 上**只保证终结浏览器本体**：孙进程（渲染进程、GPU 进程）由 Chromium
   * 自己在其主进程退出时收尾，本类不额外保证（用 `taskkill /T` 属尽力而为，
   * 且需要同权限，失败不报错——清理失败不该毁掉已经拿到的截图结果）。
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
    if (child === undefined) {
      return;
    }
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

  /**
   * 等待 stderr 上的 `/DevTools listening on ws://…`，超时或进程提前退出即失败。
   *
   * @param child 子进程。
   * @returns 端点信息。
   */
  private async awaitDevToolsUrl(child: ChromeChild): Promise<ChromeLaunchResult> {
    const timeoutMs = this.options.launchTimeoutMs ?? ChromeProcess.DEFAULT_LAUNCH_TIMEOUT_MS;
    return await new Promise<ChromeLaunchResult>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: ChromeLaunchResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.stderr.removeListener('data', onData);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
        if (error !== undefined) {
          reject(error);
        } else if (value !== undefined) {
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        finish(
          new Error(
            `浏览器未在 ${String(timeoutMs)}ms 内上报 DevTools 端点。stderr 尾部：${ChromeProcess.tailOf(this.stderrTail)}`,
          ),
        );
      }, timeoutMs);
      const onData = (chunk: Buffer): void => {
        this.stderrBuffer += chunk.toString('utf8');
        const lines = this.stderrBuffer.split(/\r?\n/);
        this.stderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
          ChromeProcess.keepTail(this.stderrTail, line.trim());
          const match = DEVTOOLS_LINE.exec(line);
          if (match?.[1] !== undefined) {
            const url = match[1];
            const port = ChromeProcess.portOf(url);
            if (port !== null) {
              finish(undefined, { webSocketUrl: url, port });
            }
          }
        }
      };
      const onExit = (code: number | null): void => {
        finish(
          new Error(
            `浏览器进程提前退出（code=${String(code)}）。stderr 尾部：${ChromeProcess.tailOf(this.stderrTail)}`,
          ),
        );
      };
      const onError = (error: Error): void => {
        finish(new Error(`浏览器进程启动失败: ${error.message}`));
      };
      child.stderr.on('data', onData);
      child.once('exit', onExit);
      child.once('error', onError);
    });
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
