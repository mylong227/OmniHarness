import { TOOL_NAMES } from '../../../ports/tool/toolNames.ts';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.ts';
import type {
  BrowserActionKind,
  BrowserActionPort,
  BrowserActionRequest,
  BrowserActionResult,
} from '../../../ports/tool/browserAction.ts';
import { PlaywrightBrowserSession } from '../../browser/playwrightBrowserSession.ts';
import { BrowserSession } from '../../browser/browserSession.ts';
import { log } from '../../../util/logger.ts';

/** 动作工具选项。 */
export interface BrowserActToolOptions {
  /** 注入执行体（测试用假实现；缺省懒建真实浏览器会话，默认 Playwright、回退 CDP）。 */
  readonly session?: BrowserActionPort | undefined;
  /** 空闲关闭毫秒数（默认 180s；每次动作后重置）。 */
  readonly idleCloseMs?: number | undefined;
  /** Playwright 浏览器可执行文件（缺省用 ChromeLocator；测试/自定义安装可用）。 */
  readonly browserExecutablePath?: string | undefined;
  /** Playwright 执行体工厂（测试注入；缺省懒建真实会话）。 */
  readonly playwrightFactory?: (() => BrowserActionPort & { close(): Promise<void> }) | undefined;
  /** CDP 回退执行体工厂（测试注入；缺省懒建 BrowserSession）。 */
  readonly cdpFactory?: (() => BrowserSession) | undefined;
}

/**
 * `browser_act` 工具（ACT-01）：把“看一眼”升级为“点一下/输一段/等条件/读 ARIA”。
 *
 * 安全口径：动作可能改变外部系统状态（点击提交、输入表单）⇒ 进入写类工具集，
 * plan 模式与 RBAC viewer 会被拦截；`aria_snapshot`/`console`/`network` 是只读，
 * 但本工具整体按写类处理（宁可多一次审批，也不让未审批的点击穿透）。
 */
export class BrowserActTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.browserAct,
    description:
      '操作浏览器页面：打开 URL、点击、输入、按键、滚动、等待条件、读取可访问性树/console/失败网络请求。' +
      '用于改完前端后的真实交互验证；动作有审批与超时，不是任意脚本执行。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'goto',
            'click',
            'type',
            'press',
            'scroll',
            'wait_for',
            'aria_snapshot',
            'console',
            'network',
          ],
          description: '动作类型。',
        },
        url: { type: 'string', description: 'goto 的目标地址（http/https/data）。' },
        selector: { type: 'string', description: 'click/type/wait_for 的 CSS 选择器。' },
        text: { type: 'string', description: 'type 的输入文本；wait_for 可用于按正文等待。' },
        key: {
          type: 'string',
          description: 'press 的按键名（Enter/Tab/Escape/Backspace/方向键）。',
        },
        dx: { type: 'number', description: 'scroll 的水平增量（像素）。' },
        dy: { type: 'number', description: 'scroll 的垂直增量（像素）。' },
        timeout_ms: {
          type: 'number',
          description: 'wait_for 的超时毫秒数（默认 5000，上限 30000）。',
        },
      },
      required: ['action'],
    },
  };

  /** 执行体（懒建或注入）。 */
  private lazy: BrowserActionPort | undefined;
  /** 自建的浏览器执行体（close 用）。 */
  private owned: (BrowserActionPort & { close(): Promise<void> }) | undefined;
  /** CDP 回退执行体（Playwright 不可用/启动失败时懒建）。 */
  private cdp: BrowserSession | undefined;
  /** 是否已切到 CDP 回退（后续动作直接走 CDP，避免每次先撞一次 Playwright 失败）。 */
  private usingCdp = false;
  /** 空闲关闭定时器。 */
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** 是否已关闭。 */
  private closed = false;

  /**
   * @param options 注入执行体与空闲关闭时间。
   */
  public constructor(private readonly options: BrowserActToolOptions = {}) {}

  /**
   * 执行动作。
   * @param call 工具调用。
   * @param _context 工具上下文（本工具不读工作区）。
   * @returns 工具结果。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const action = String(call.arguments['action'] ?? '');
    if (!BrowserActTool.isKind(action)) {
      return { callId: call.id, ok: false, error: `未知 browser_act 动作：${action}` };
    }
    const request: BrowserActionRequest = {
      kind: action,
      ...(typeof call.arguments['url'] === 'string' ? { url: call.arguments['url'] } : {}),
      ...(typeof call.arguments['selector'] === 'string'
        ? { selector: call.arguments['selector'] }
        : {}),
      ...(typeof call.arguments['text'] === 'string' ? { text: call.arguments['text'] } : {}),
      ...(typeof call.arguments['key'] === 'string' ? { key: call.arguments['key'] } : {}),
      ...(typeof call.arguments['dx'] === 'number' ? { dx: call.arguments['dx'] } : {}),
      ...(typeof call.arguments['dy'] === 'number' ? { dy: call.arguments['dy'] } : {}),
      ...(typeof call.arguments['timeout_ms'] === 'number'
        ? { timeoutMs: call.arguments['timeout_ms'] }
        : {}),
    };
    try {
      const result = await this.run(request);
      this.touchIdle();
      return result.ok
        ? { callId: call.id, ok: true, output: result.output }
        : { callId: call.id, ok: false, error: result.output };
    } catch (error) {
      this.touchIdle();
      return {
        callId: call.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 关闭自建浏览器（幂等）。工具实例被回收时由进程退出兜底；这里提供显式入口。
   * @returns 关闭完成。
   */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    try {
      await this.owned?.close();
      await this.cdp?.close();
    } finally {
      // 2026-10-21 修：空闲关闭是「省资源」，不是「销毁工具」。此前置 closed=true 后不复位
      // lazy，下次动作会复用已关闭的会话再拉起浏览器，而后续 close 直接早退 ⇒ 浏览器永不关闭。
      // 这里清掉 lazy 并复位 closed，使下一次动作重新懒建、下一次空闲关闭仍然生效。
      this.owned = undefined;
      this.cdp = undefined;
      this.lazy = undefined;
      this.closed = false;
    }
  }

  /**
   * 执行动作（Playwright 为主；启动失败自动回退 CDP）。
   * @param request 动作请求。
   * @returns 动作结果。
   */
  private async run(request: BrowserActionRequest): Promise<BrowserActionResult> {
    // 显式降级：`OMNI_BROWSER_ENGINE=cdp` 直接在 CDP 上跑，不先尝试 Playwright。
    if (this.options.session === undefined && process.env.OMNI_BROWSER_ENGINE === 'cdp') {
      this.usingCdp = true;
    }
    if (this.usingCdp) {
      return await this.cdpPort().act(request);
    }
    try {
      return await this.actionPort().act(request);
    } catch (error) {
      // 注入执行体时不回退（测试/调用方明确指定了引擎）。
      if (this.options.session !== undefined) throw error;
      // Playwright 启动失败：`ensurePage` 抛错（缺 optional 依赖/缺 Chrome/启动崩溃）。
      // 动作级失败在 `PlaywrightBrowserSession.act` 内已转成 ok:false，不会走到这里。
      log.warn('browser.engine.fallback', {
        from: 'playwright',
        to: 'cdp',
        error: error instanceof Error ? error.message : String(error),
      });
      this.usingCdp = true;
      await this.owned?.close();
      this.owned = undefined;
      this.lazy = undefined;
      return await this.cdpPort().act(request);
    }
  }

  /**
   * 取 CDP 回退执行体（懒建）。
   * @returns 动作端口。
   */
  private cdpPort(): BrowserSession {
    this.cdp ??= this.options.cdpFactory?.() ?? new BrowserSession();
    return this.cdp;
  }

  /**
   * 取执行体：注入优先；否则懒建 Playwright 引擎（复用本机 Chrome）。
   * @returns 动作端口。
   */
  private actionPort(): BrowserActionPort {
    if (this.options.session !== undefined) {
      return this.options.session;
    }
    if (this.lazy === undefined) {
      this.owned =
        this.options.playwrightFactory?.() ??
        new PlaywrightBrowserSession({
          ...(this.options.browserExecutablePath !== undefined
            ? { executablePath: this.options.browserExecutablePath }
            : {}),
        });
      this.lazy = this.owned;
    }
    return this.lazy;
  }

  /**
   * 重置空闲关闭计时器。
   * @returns 无返回值。
   */
  private touchIdle(): void {
    if (this.options.session !== undefined) return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.close().catch((error: unknown) => {
        log.warn('browser.idle.close_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.options.idleCloseMs ?? 180_000);
    this.idleTimer.unref?.();
  }

  /**
   * 动作名是否合法。
   * @param value 原始值。
   * @returns 合法动作时为 true。
   */
  private static isKind(value: string): value is BrowserActionKind {
    return (
      value === 'goto' ||
      value === 'click' ||
      value === 'type' ||
      value === 'press' ||
      value === 'scroll' ||
      value === 'wait_for' ||
      value === 'aria_snapshot' ||
      value === 'console' ||
      value === 'network'
    );
  }
}
