/**
 * 浏览器会话：启动 headless Chromium、打开页面、截图。
 *
 * 这是 E1（CDP 截图）从**测试脚本**提升为**产品能力**后的执行体：
 * 原先它只存在于 `web/test/browserHarness.mjs`（测试专用、每次拉起一次），
 * 现在被 `browser_screenshot` 工具复用，并且**跨调用复用同一个浏览器**
 * ——每次调用都冷启一个 Chromium 要几秒，对「改完前端看一眼」这种高频动作太贵。
 *
 * ## 三条硬约束
 *
 * 1. **不能挂死**：每个 await 都有界（启动超时、导航等待超时、命令超时三层）。
 * 2. **不能泄漏进程**：无论成功失败，`close()` 幂等且总会被调用；
 *    启动中途失败也要把已 spawn 的子进程收掉。
 * 3. **不能污染宿主**：用户数据目录是本进程独占的临时目录，用完删除。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromeLocator } from './chromeLocator.js';
import type { ChromeLocatorOptions, ChromeLookup } from './chromeLocator.js';
import { ChromeProcess } from './chromeProcess.js';
import type { ChromeLaunchResult, ChromeProcessOptions } from './chromeProcess.js';
import { CdpClient } from './cdpClient.js';
import { ImageProbe } from '../../util/imageProbe.js';

/**
 * 浏览器进程最小面：`ChromeProcess` 结构化满足；测试可注入假实现（不真起浏览器）。
 */
export interface ChromeProcessLike {
  /**
   * 启动浏览器并等待 DevTools 端点就绪。
   *
   * @returns 端点信息。
   */
  launch(): Promise<ChromeLaunchResult>;

  /**
   * 结束浏览器进程（幂等）。
   *
   * @returns 无返回值。
   */
  kill(): void;
}

/** 截图请求（参数已由工具层校验/夹紧）。 */
export interface ScreenshotRequest {
  /** 目标地址（http / https / data）。 */
  readonly url: string;
  /** 视口宽（像素）。 */
  readonly width: number;
  /** 视口高（像素）。 */
  readonly height: number;
  /** 是否截取整个可滚动区域（否则只截视口）。 */
  readonly fullPage: boolean;
  /** 页面加载完成后的额外等待毫秒数（给动画/异步渲染留时间）。 */
  readonly waitMs: number;
}

/** 截图结果。 */
export interface ScreenshotResult {
  /** PNG 字节。 */
  readonly png: Buffer;
  /** 实际宽度（从 PNG 头读出，保证「说的是真值」）。 */
  readonly width: number;
  /** 实际高度（从 PNG 头读出）。 */
  readonly height: number;
  /** 导航结束后的最终地址（可能因重定向而不同于请求地址）。 */
  readonly finalUrl: string;
  /** 页面标题（取不到为空串）。 */
  readonly title: string;
}

/** 会话选项。 */
export interface BrowserSessionOptions {
  /** 显式指定的浏览器可执行文件（最高优先级）。 */
  readonly chromePath?: string | undefined;
  /** 用户数据目录（缺省自建临时目录，`close()` 时删除）。 */
  readonly userDataDir?: string | undefined;
  /** 单条 CDP 命令超时毫秒数。 */
  readonly timeoutMs?: number | undefined;
  /** 浏览器启动（等 DevTools 端点）超时毫秒数。 */
  readonly launchTimeoutMs?: number | undefined;
  /** 等待页面加载事件的超时毫秒数（默认 30s）。 */
  readonly loadTimeoutMs?: number | undefined;
  /** 浏览器定位选项（透传给定位函数）。 */
  readonly locator?: ChromeLocatorOptions | undefined;
  /**
   * 浏览器定位函数（默认 {@link ChromeLocator.locate}）。
   * 注入后即可在**不装浏览器**的机器上测「找不到浏览器」这条失败路径。
   */
  readonly locate?: ((options: ChromeLocatorOptions) => ChromeLookup) | undefined;
  /** 浏览器进程工厂（默认 `new ChromeProcess(...)`）；测试可注入假实现（不真起浏览器）。 */
  readonly createProcess?: ((options: ChromeProcessOptions) => ChromeProcessLike) | undefined;
  /**
   * CDP 连接函数（默认新建 {@link CdpClient} 并 `connect`）。
   * 测试可注入**假 CDP 连接**，从而在不依赖真 Chrome 的前提下走通整条截图链路。
   */
  readonly connectCdp?: ((url: string) => Promise<CdpClient>) | undefined;
}

/**
 * 可复用的 headless Chromium 会话。
 */
export class BrowserSession {
  /** 默认等待加载事件的超时。 */
  public static readonly DEFAULT_LOAD_TIMEOUT_MS = 30_000;

  /** CDP 客户端（首次截图时建立）。 */
  private client: CdpClient | undefined;

  /** 浏览器子进程（首次截图时建立）。 */
  private process: ChromeProcessLike | undefined;

  /** 页面会话 id（`Target.attachToTarget` 得到）。 */
  private pageSessionId: string | undefined;

  /** 本会话自建的用户数据目录（close 时删除；外部传入的不动）。 */
  private ownedUserDataDir: string | undefined;

  /** 进行中的启动 Promise（并发调用共享一次启动）。 */
  private starting: Promise<void> | undefined;

  /** 是否已关闭。 */
  private closed = false;

  public constructor(private readonly options: BrowserSessionOptions = {}) {}

  /**
   * 打开页面并截图。
   *
   * @param request 截图请求。
   * @returns 截图结果（含实际尺寸与最终地址）。
   */
  public async screenshot(request: ScreenshotRequest): Promise<ScreenshotResult> {
    await this.ensureSession();
    const client = this.requireClient();
    const session = this.requireSession();
    await client.send(
      'Emulation.setDeviceMetricsOverride',
      { width: request.width, height: request.height, deviceScaleFactor: 1, mobile: false },
      session,
    );
    await client.send('Page.enable', {}, session);
    const finalUrl = await this.navigate(client, session, request);
    const png = await this.capture(client, session, request.fullPage);
    const probed = ImageProbe.probe(png, '.png');
    return {
      png,
      width: probed?.width ?? request.width,
      height: probed?.height ?? request.height,
      finalUrl,
      title: await this.title(client, session),
    };
  }

  /**
   * 关闭会话：断开 CDP、结束浏览器、删除自建的用户数据目录。幂等。
   *
   * @returns 关闭完成。
   */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      if (this.client !== undefined && this.pageSessionId !== undefined) {
        await this.client.send('Page.close', {}, this.pageSessionId);
      }
    } catch {
      // 关闭期的协议失败无所谓——下面照样杀进程。
    }
    this.client?.close();
    this.client = undefined;
    this.pageSessionId = undefined;
    this.process?.kill();
    this.process = undefined;
    const owned = this.ownedUserDataDir;
    this.ownedUserDataDir = undefined;
    if (owned !== undefined) {
      // Windows 上浏览器刚退出时 profile 目录可能仍被短暂占用，删不掉不算错误。
      try {
        rmSync(owned, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* best-effort */
      }
    }
  }

  /**
   * 确保浏览器已启动且页面会话已建立（并发调用共享同一次启动）。
   *
   * @returns 启动完成。
   */
  private async ensureSession(): Promise<void> {
    if (this.closed) {
      throw new Error('浏览器会话已关闭');
    }
    if (this.client !== undefined && this.pageSessionId !== undefined) {
      return;
    }
    this.starting ??= this.startSession();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  /**
   * 真启动：定位可执行文件 → 拉起 → 连浏览器端点 → 建页并附着。
   *
   * 三处平台细节（定位 / 起进程 / 连 CDP）都经可注入接缝，缺省即真实实现；
   * 这样「找不到浏览器」「CDP 连不上」这些**最常见的线上失败**能在单测里被确定性地覆盖，
   * 而不是只能靠一台装了 Chrome 的机器去碰运气。
   *
   * @returns 启动完成。
   */
  private async startSession(): Promise<void> {
    const locate = this.options.locate ?? ChromeLocator.locate;
    const lookup = locate({ explicit: this.options.chromePath });
    if (lookup.executable === null) {
      throw new Error(
        '未找到 Chrome/Edge 可执行文件。可用 CHROME_PATH 环境变量指定绝对路径后重试。' +
          `已尝试：${lookup.searched.slice(0, 8).join(' / ')}${lookup.searched.length > 8 ? ' …' : ''}`,
      );
    }
    const userDataDir = this.options.userDataDir ?? mkdtempSync(join(tmpdir(), 'omni-chrome-'));
    if (this.options.userDataDir === undefined) {
      this.ownedUserDataDir = userDataDir;
    }
    const createProcess =
      this.options.createProcess ??
      ((processOptions: ChromeProcessOptions): ChromeProcessLike =>
        new ChromeProcess(processOptions));
    const chrome = createProcess({
      executable: lookup.executable,
      userDataDir,
      ...(this.options.launchTimeoutMs !== undefined
        ? { launchTimeoutMs: this.options.launchTimeoutMs }
        : {}),
    });
    this.process = chrome;
    try {
      const launched = await chrome.launch();
      const client = await this.connectCdp(launched.webSocketUrl);
      this.client = client;
      const target = (await client.send('Target.createTarget', { url: 'about:blank' })) as {
        targetId?: unknown;
      };
      const targetId = target.targetId;
      if (typeof targetId !== 'string') {
        throw new Error('CDP Target.createTarget 未返回 targetId');
      }
      const attached = (await client.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      })) as { sessionId?: unknown };
      if (typeof attached.sessionId !== 'string') {
        throw new Error('CDP Target.attachToTarget 未返回 sessionId');
      }
      this.pageSessionId = attached.sessionId;
    } catch (error) {
      // 启动中途失败也必须收干净：否则每失败一次就漏一个 Chromium 进程。
      await this.close();
      this.closed = false;
      throw error;
    }
  }

  /**
   * 建立 CDP 连接（缺省真实连接，测试可注入假连接）。
   *
   * @param url DevTools 浏览器级 WebSocket 端点。
   * @returns 已连接的 CDP 客户端。
   */
  private async connectCdp(url: string): Promise<CdpClient> {
    const injected = this.options.connectCdp;
    if (injected !== undefined) {
      return await injected(url);
    }
    const client = new CdpClient(
      this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {},
    );
    await client.connect(url);
    return client;
  }

  /**
   * 导航并等待加载（事件优先，超时兜底）。
   *
   * 事件先订阅再导航——反过来的话，快页面会在订阅之前就发完 `loadEventFired`，
   * 于是永远等不到。但**等不到不代表失败**：超时后照常继续截图（拿到的可能是
   * 部分渲染的页面，这比直接报「超时」对「看一眼页面长什么样」的诉求更有用）。
   *
   * @param client CDP 客户端。
   * @param session 页面会话 id。
   * @param request 截图请求（提供 url）。
   * @returns 导航后的最终地址。
   */
  private async navigate(
    client: CdpClient,
    session: string,
    request: ScreenshotRequest,
  ): Promise<string> {
    let loaded = false;
    const off = client.on('Page.loadEventFired', () => {
      loaded = true;
    });
    try {
      await client.send('Page.navigate', { url: request.url }, session);
      const timeoutMs = this.options.loadTimeoutMs ?? BrowserSession.DEFAULT_LOAD_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      while (!loaded && Date.now() < deadline) {
        await BrowserSession.sleep(50);
      }
      if (request.waitMs > 0) {
        await BrowserSession.sleep(request.waitMs);
      }
    } finally {
      off();
    }
    return await this.evaluate(client, session, 'location.href');
  }

  /**
   * 抓取截图并解码。
   *
   * @param client CDP 客户端。
   * @param session 页面会话 id。
   * @param fullPage 是否截整页。
   * @returns PNG 字节。
   */
  private async capture(client: CdpClient, session: string, fullPage: boolean): Promise<Buffer> {
    const result = (await client.send(
      'Page.captureScreenshot',
      fullPage ? { format: 'png', captureBeyondViewport: true } : { format: 'png' },
      session,
    )) as { data?: unknown };
    if (typeof result.data !== 'string' || result.data === '') {
      throw new Error('CDP Page.captureScreenshot 未返回图像数据');
    }
    return Buffer.from(result.data, 'base64');
  }

  /**
   * 取页面标题（取不到不报错——标题只是元数据）。
   *
   * @param client CDP 客户端。
   * @param session 页面会话 id。
   * @returns 标题；失败为空串。
   */
  private async title(client: CdpClient, session: string): Promise<string> {
    try {
      return await this.evaluate(client, session, 'document.title');
    } catch {
      return '';
    }
  }

  /**
   * 在页面上下文求值一个返回字符串的表达式。
   *
   * @param client CDP 客户端。
   * @param session 页面会话 id。
   * @param expression 表达式（本类只传字面量，不接受外部拼接）。
   * @returns 字符串结果；非字符串时为空串。
   */
  private async evaluate(client: CdpClient, session: string, expression: string): Promise<string> {
    const result = (await client.send(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      session,
    )) as { result?: { value?: unknown } };
    const value = result.result?.value;
    return typeof value === 'string' ? value : '';
  }

  /**
   * 取已建立的客户端；未建立即抛错（调用方须先 `ensureSession`）。
   *
   * @returns CDP 客户端。
   */
  private requireClient(): CdpClient {
    if (this.client === undefined) {
      throw new Error('浏览器会话尚未建立');
    }
    return this.client;
  }

  /**
   * 取出当前页面会话 ID，未建立则抛错（由 {@link ensureSession} 保证存在）。
   *
   * @returns 页面会话 ID。
   */
  private requireSession(): string {
    if (this.pageSessionId === undefined) {
      throw new Error('浏览器页面会话尚未建立');
    }
    return this.pageSessionId;
  }

  /**
   * 睡眠指定毫秒。
   *
   * @param ms 毫秒数。
   * @returns 到点后 resolve。
   */
  private static sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
