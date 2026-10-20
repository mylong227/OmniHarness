import { createRequire } from 'node:module';
import { ChromeLocator } from './chromeLocator.ts';
import { ImageProbe } from '../../util/imageProbe.ts';
import type { ScreenshotRequest, ScreenshotResult } from './browserSession.ts';
import type {
  BrowserActionPort,
  BrowserActionRequest,
  BrowserActionResult,
} from '../../ports/tool/browserAction.ts';

/** 本地最小结构：避免 `import type` 把 optional 依赖变成编译期硬依赖。 */
interface PlaywrightLocator {
  first(): PlaywrightLocator;
  click(options: { timeout: number }): Promise<void>;
  fill(value: string, options: { timeout: number }): Promise<void>;
  waitFor(options: { state: 'visible'; timeout: number }): Promise<void>;
  ariaSnapshot(): Promise<string>;
}

interface PlaywrightConsoleMessage {
  type(): string;
  text(): string;
}

interface PlaywrightRequest {
  method(): string;
  url(): string;
  failure(): { errorText?: string } | null;
}

interface PlaywrightResponse {
  status(): number;
  url(): string;
}

interface PlaywrightPage {
  goto(
    url: string,
    options: { waitUntil: 'domcontentloaded' | 'load'; timeout: number },
  ): Promise<PlaywrightResponse | null>;
  url(): string;
  title(): Promise<string>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { fullPage: boolean }): Promise<Buffer>;
  locator(selector: string): PlaywrightLocator;
  getByText(text: string): PlaywrightLocator;
  keyboard: { press(key: string): Promise<void> };
  mouse: { wheel(dx: number, dy: number): Promise<void> };
  on(event: 'console', listener: (message: PlaywrightConsoleMessage) => void): void;
  on(event: 'pageerror', listener: (error: Error) => void): void;
  on(event: 'requestfailed', listener: (request: PlaywrightRequest) => void): void;
  on(event: 'response', listener: (response: PlaywrightResponse) => void): void;
}

interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightBrowser {
  newContext(options: { viewport: { width: number; height: number } }): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

/** 默认动作超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 10_000;
/** console/network 观测保留条数上限。 */
const MAX_OBSERVATIONS = 100;

/** 构造选项。 */
export interface PlaywrightBrowserSessionOptions {
  /** 浏览器可执行文件；缺省用 `ChromeLocator`。 */
  readonly executablePath?: string | undefined;
  /** 是否 headless（默认 true）。 */
  readonly headless?: boolean | undefined;
}

/**
 * 浏览器动作的 Playwright 默认引擎（ACT-01，2026-10-20）。
 *
 * 为什么是默认：Playwright 的 actionability（元素可见/可点/稳定）、自动等待、iframe/shadow DOM
 * 语义是商用交互验证的底线；`playwright-core` 约 13MB 但复用本机 Chrome（不下载浏览器）。
 * `BrowserScreenshotTool` 在启动失败时回退 CDP；`browser_act` 不再保留 CDP 动作实现。
 */
export class PlaywrightBrowserSession implements BrowserActionPort {
  /** 浏览器实例（懒启动）。 */
  private browser: PlaywrightBrowser | undefined;
  /** 浏览器上下文（独立 cookie/存储）。 */
  private context: PlaywrightContext | undefined;
  /** 当前页面。 */
  private page: PlaywrightPage | undefined;
  /** 最近 console 输出（有界）。 */
  private readonly consoleLines: string[] = [];
  /** 最近失败网络请求（有界）。 */
  private readonly networkFailures: string[] = [];

  /**
   * @param options 浏览器可执行文件/headless 选项。
   */
  public constructor(private readonly options: PlaywrightBrowserSessionOptions = {}) {}

  /**
   * 执行一个浏览器动作。
   * @param request 动作请求。
   * @returns 动作结果（可恢复失败为 ok:false + 可读原因）。
   */
  public async act(request: BrowserActionRequest): Promise<BrowserActionResult> {
    // 启动失败必须向上抛：BrowserActTool 据此回退 CDP；动作级失败仍在下面转成 ok:false。
    const page = await this.ensurePage();
    try {
      switch (request.kind) {
        case 'goto':
          return await this.goto(page, request);
        case 'click':
          return await this.click(page, request);
        case 'type':
          return await this.type(page, request);
        case 'press':
          return await this.press(page, request);
        case 'scroll':
          return await this.scroll(page, request);
        case 'wait_for':
          return await this.waitFor(page, request);
        case 'aria_snapshot':
          return { ok: true, output: await page.locator('body').ariaSnapshot() };
        case 'console':
          return { ok: true, output: this.consoleLines.join('\n') || '（无 console 输出）' };
        case 'network':
          return { ok: true, output: this.networkFailures.join('\n') || '（无失败请求）' };
        default:
          return { ok: false, output: `不支持的浏览器动作：${String(request.kind)}` };
      }
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 截图（与 `BrowserSession` 的 `ScreenshotSession` 结构化兼容）。
   * @param request 截图请求。
   * @returns PNG + 实际尺寸 + 最终地址/标题。
   */
  public async screenshot(request: ScreenshotRequest): Promise<ScreenshotResult> {
    const page = await this.ensurePage();
    await page.setViewportSize({ width: request.width, height: request.height });
    await page.goto(request.url, { waitUntil: 'load', timeout: 30_000 });
    if (request.waitMs > 0) await page.waitForTimeout(request.waitMs);
    const png = await page.screenshot({ fullPage: request.fullPage });
    const info = ImageProbe.probe(png);
    return {
      png,
      width: info?.width ?? request.width,
      height: info?.height ?? request.height,
      finalUrl: page.url(),
      title: await page.title(),
    };
  }

  /**
   * 关闭浏览器（幂等）。
   * @returns 无返回值。
   */
  public async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
    this.context = undefined;
    this.browser = undefined;
    this.page = undefined;
  }

  /**
   * 懒启动浏览器并接上观测。
   * @returns 已就绪页面。
   */
  private async ensurePage(): Promise<PlaywrightPage> {
    if (this.page !== undefined) return this.page;
    const chrome = ChromeLocator.locate();
    const executablePath = this.options.executablePath ?? chrome.executable;
    if (executablePath === null) throw new Error('未找到 Chrome/Edge，无法启动浏览器');
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright-core') as {
      chromium: {
        launch(options: {
          executablePath: string;
          headless: boolean;
          args: string[];
        }): Promise<unknown>;
      };
    };
    this.browser = (await chromium.launch({
      executablePath,
      headless: this.options.headless ?? true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })) as PlaywrightBrowser;
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await this.context.newPage();
    this.attachObservers(page);
    this.page = page;
    return page;
  }

  /**
   * 挂 console / pageerror / 失败请求观测。
   * @param page 页面实例。
   * @returns 无返回值。
   */
  private attachObservers(page: PlaywrightPage): void {
    page.on('console', (message: PlaywrightConsoleMessage) => {
      this.push(this.consoleLines, `[${message.type()}] ${message.text()}`);
    });
    page.on('pageerror', (error: Error) => {
      this.push(this.consoleLines, `[pageerror] ${error.message}`);
    });
    page.on('requestfailed', (request) => {
      this.push(
        this.networkFailures,
        `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
      );
    });
    page.on('response', (response: PlaywrightResponse) => {
      if (response.status() >= 400) {
        this.push(this.networkFailures, `${String(response.status())} ${response.url()}`);
      }
    });
  }

  /**
   * 保留有界观测。
   * @param lines 目标数组。
   * @param line 新行。
   * @returns 无返回值。
   */
  private push(lines: string[], line: string): void {
    lines.push(line);
    if (lines.length > MAX_OBSERVATIONS) lines.shift();
  }

  /**
   * goto。
   * @param page 页面实例。
   * @param request 动作请求。
   * @returns 动作结果。
   */
  private async goto(
    page: PlaywrightPage,
    request: BrowserActionRequest,
  ): Promise<BrowserActionResult> {
    const url = request.url ?? '';
    if (!/^https?:\/\/|^data:/u.test(url))
      return { ok: false, output: 'goto 需要 http/https/data URL' };
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const status = response === null ? 'no-response' : String(response.status());
    return { ok: true, output: `${page.url()} | ${await page.title()} | HTTP ${status}` };
  }

  /**
   * click（Playwright actionability）。
   * @param page 页面实例。
   * @param request 动作请求。
   * @returns 动作结果。
   */
  private async click(
    page: PlaywrightPage,
    request: BrowserActionRequest,
  ): Promise<BrowserActionResult> {
    if (request.selector === undefined || request.selector === '') {
      return { ok: false, output: 'click 需要 selector' };
    }
    await page
      .locator(request.selector)
      .first()
      .click({
        timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    return { ok: true, output: `clicked ${request.selector}` };
  }

  /**
   * type（fill，触发 input/change）。
   * @param page 页面实例。
   * @param request 动作请求。
   * @returns 动作结果。
   */
  private async type(
    page: PlaywrightPage,
    request: BrowserActionRequest,
  ): Promise<BrowserActionResult> {
    if (request.selector === undefined || request.selector === '') {
      return { ok: false, output: 'type 需要 selector' };
    }
    await page
      .locator(request.selector)
      .first()
      .fill(request.text ?? '', {
        timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    return { ok: true, output: `typed ${String((request.text ?? '').length)} chars` };
  }

  /**
   * press。
   * @param page 页面实例。
   * @param request 动作请求。
   * @returns 动作结果。
   */
  private async press(
    page: PlaywrightPage,
    request: BrowserActionRequest,
  ): Promise<BrowserActionResult> {
    await page.keyboard.press(request.key ?? 'Enter');
    return { ok: true, output: `pressed ${request.key ?? 'Enter'}` };
  }

  /**
   * scroll。
   * @param page 页面实例。
   * @param request 动作请求。
   * @returns 动作结果。
   */
  private async scroll(
    page: PlaywrightPage,
    request: BrowserActionRequest,
  ): Promise<BrowserActionResult> {
    await page.mouse.wheel(request.dx ?? 0, request.dy ?? 600);
    return {
      ok: true,
      output: `scrolled dx=${String(request.dx ?? 0)} dy=${String(request.dy ?? 600)}`,
    };
  }

  /**
   * wait_for（selector 或正文）。
   * @param page 页面实例。
   * @param request 动作请求。
   * @returns 动作结果。
   */
  private async waitFor(
    page: PlaywrightPage,
    request: BrowserActionRequest,
  ): Promise<BrowserActionResult> {
    const timeout = request.timeoutMs ?? 5_000;
    if (request.selector !== undefined && request.selector !== '') {
      await page.locator(request.selector).first().waitFor({ state: 'visible', timeout });
      return { ok: true, output: `visible ${request.selector}` };
    }
    if (request.text !== undefined && request.text !== '') {
      await page.getByText(request.text).first().waitFor({ state: 'visible', timeout });
      return { ok: true, output: `visible text ${request.text}` };
    }
    return { ok: false, output: 'wait_for 需要 selector 或 text' };
  }
}
