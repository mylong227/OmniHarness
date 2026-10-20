/**
 * CDP 浏览器动作执行体（2026-10-21）。
 *
 * 从 `BrowserSession` 拆出，原因有两层：
 *  - `BrowserSession` 同时承担截图会话生命周期与九个动作，已越过「上帝类」门禁；
 *  - 动作语义（选择器/键盘/等待/AX 树）与浏览器启动/关闭是两件事，拆开后各自可单测。
 *
 * 这是 `browser_act` 在 Playwright 不可用/启动失败时的回退路径：语义弱于 Playwright
 * （没有 actionability 自动等待、iframe 穿透），但九个动作齐全，保证 optional 依赖缺失时仍可用。
 */
import type { CdpClient } from './cdpClient.ts';
import type { BrowserActionRequest, BrowserActionResult } from '../../ports/tool/browserAction.ts';

import type { BrowserObservations } from './browserObservations.ts';

/** 动作执行体依赖。 */
export interface CdpBrowserActionsOptions {
  /** CDP 客户端。 */
  readonly client: CdpClient;
  /** 页面会话 id。 */
  readonly session: string;
  /** 导航函数（由 BrowserSession 注入，复用其 load 等待逻辑）。 */
  readonly navigate: (url: string, waitMs: number) => Promise<string>;
  /** console / 网络观测。 */
  readonly observations: BrowserObservations;
}

/** CDP 版浏览器动作执行体。 */
export class CdpBrowserActions {
  /**
   * @param options 客户端、页面会话、导航与观测。
   */
  public constructor(private readonly options: CdpBrowserActionsOptions) {}

  /**
   * 执行一个浏览器动作。
   * @param request 动作请求。
   * @returns 动作结果（可恢复失败为 ok:false + 可读原因）。
   */
  public async act(request: BrowserActionRequest): Promise<BrowserActionResult> {
    try {
      switch (request.kind) {
        case 'goto':
          return await this.actGoto(request);
        case 'click':
          return await this.actClick(request);
        case 'type':
          return await this.actType(request);
        case 'press':
          return await this.actPress(request);
        case 'scroll':
          return await this.actScroll(request);
        case 'wait_for':
          return await this.actWaitFor(request);
        case 'aria_snapshot':
          return await this.actAriaSnapshot();
        case 'console':
          return { ok: true, output: this.options.observations.consoleOutput() };
        case 'network':
          return { ok: true, output: this.options.observations.networkOutput() };
        default:
          return { ok: false, output: `不支持的浏览器动作：${String(request.kind)}` };
      }
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 打开页面并等待 load。
   * @param request 动作请求。
   * @returns 动作结果。
   */
  private async actGoto(request: BrowserActionRequest): Promise<BrowserActionResult> {
    const url = request.url?.trim() ?? '';
    if (url === '') return { ok: false, output: 'goto 需要非空 url' };
    const finalUrl = await this.options.navigate(url, 0);
    return { ok: true, output: `已打开 ${finalUrl}` };
  }

  /**
   * 点击一个 CSS 选择器。
   * @param request 动作请求。
   * @returns 动作结果。
   */
  private async actClick(request: BrowserActionRequest): Promise<BrowserActionResult> {
    const selector = request.selector?.trim() ?? '';
    if (selector === '') return { ok: false, output: 'click 需要非空 selector' };
    const value = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOT_FOUND';
      el.scrollIntoView({ block: 'center' });
      el.click();
      return 'OK';
    })()`);
    return value === 'OK'
      ? { ok: true, output: `已点击 ${selector}` }
      : { ok: false, output: `未找到可点击元素：${selector}` };
  }

  /**
   * 向输入框写入文本（原生 setter + input/change 事件，兼容 React 受控组件）。
   * @param request 动作请求。
   * @returns 动作结果。
   */
  private async actType(request: BrowserActionRequest): Promise<BrowserActionResult> {
    const selector = request.selector?.trim() ?? '';
    if (selector === '') return { ok: false, output: 'type 需要非空 selector' };
    const text = request.text ?? '';
    const value = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOT_FOUND';
      el.focus();
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && typeof desc.set === 'function') desc.set.call(el, ${JSON.stringify(text)});
      else el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'OK';
    })()`);
    return value === 'OK'
      ? { ok: true, output: `已向 ${selector} 输入 ${String(text.length)} 个字符` }
      : { ok: false, output: `未找到可输入元素：${selector}` };
  }

  /**
   * 敲一个按键（CDP Input.dispatchKeyEvent；覆盖常用键）。
   * @param request 动作请求。
   * @returns 动作结果。
   */
  private async actPress(request: BrowserActionRequest): Promise<BrowserActionResult> {
    const key = request.key?.trim() ?? '';
    if (key === '') return { ok: false, output: 'press 需要非空 key' };
    const info = CdpBrowserActions.keyInfoOf(key);
    for (const type of ['keyDown', 'keyUp'] as const) {
      await this.options.client.send(
        'Input.dispatchKeyEvent',
        {
          type,
          key,
          code: info.code,
          windowsVirtualKeyCode: info.keyCode,
          nativeVirtualKeyCode: info.keyCode,
        },
        this.options.session,
      );
    }
    return { ok: true, output: `已按键 ${key}` };
  }

  /**
   * 滚动页面。
   * @param request 动作请求。
   * @returns 动作结果。
   */
  private async actScroll(request: BrowserActionRequest): Promise<BrowserActionResult> {
    const dx = Number.isFinite(request.dx) ? (request.dx ?? 0) : 0;
    const dy = Number.isFinite(request.dy) ? (request.dy ?? 0) : 0;
    await this.evaluate(
      `(() => { window.scrollBy(${String(dx)}, ${String(dy)}); return 'OK'; })()`,
    );
    return { ok: true, output: `已滚动 dx=${String(dx)} dy=${String(dy)}` };
  }

  /**
   * 等待选择器出现或正文包含指定文本。
   * @param request 动作请求。
   * @returns 动作结果。
   */
  private async actWaitFor(request: BrowserActionRequest): Promise<BrowserActionResult> {
    const selector = request.selector?.trim() ?? '';
    const text = request.text ?? '';
    if (selector === '' && text === '') {
      return { ok: false, output: 'wait_for 需要 selector 或 text' };
    }
    const timeoutMs = Math.min(Math.max(Math.floor(request.timeoutMs ?? 5_000), 100), 30_000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const expression =
        selector !== ''
          ? `document.querySelector(${JSON.stringify(selector)}) ? 'FOUND' : 'NO'`
          : `document.body && document.body.innerText.includes(${JSON.stringify(text)}) ? 'FOUND' : 'NO'`;
      if ((await this.evaluate(expression)) === 'FOUND') {
        return {
          ok: true,
          output: selector !== '' ? `元素已出现：${selector}` : '正文已包含目标文本',
        };
      }
      await CdpBrowserActions.sleep(100);
    }
    return { ok: false, output: `等待超时（${String(timeoutMs)}ms）` };
  }

  /**
   * 读取可访问性树（CDP Accessibility.getFullAXTree）。
   * @returns 动作结果（role/name 文本树）。
   */
  private async actAriaSnapshot(): Promise<BrowserActionResult> {
    const { client, session } = this.options;
    await client.send('Accessibility.enable', {}, session);
    const tree = (await client.send('Accessibility.getFullAXTree', {}, session)) as {
      nodes?: readonly {
        ignored?: boolean;
        role?: { value?: unknown };
        name?: { value?: unknown };
      }[];
    };
    const lines: string[] = [];
    for (const node of tree.nodes ?? []) {
      if (node.ignored === true) continue;
      const role = typeof node.role?.value === 'string' ? node.role.value : '';
      const name = typeof node.name?.value === 'string' ? node.name.value : '';
      if (role === '' && name === '') continue;
      lines.push(name === '' ? role : `${role}: ${name}`);
      if (lines.length >= 200) break;
    }
    return { ok: true, output: lines.join('\n') || '（无可访问性节点）' };
  }

  /**
   * 页面上下文求值一个返回字符串的表达式。
   * @param expression 表达式（只由本类拼接）。
   * @returns 字符串结果；非字符串时为空串。
   */
  private async evaluate(expression: string): Promise<string> {
    const { client, session } = this.options;
    const result = (await client.send(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      session,
    )) as { result?: { value?: unknown } };
    const value = result.result?.value;
    return typeof value === 'string' ? value : '';
  }

  /**
   * 常用按键 → CDP code / 虚拟键码。
   * @param key 按键名。
   * @returns code 与 keyCode。
   */
  private static keyInfoOf(key: string): { code: string; keyCode: number } {
    const table: Readonly<Record<string, { code: string; keyCode: number }>> = {
      Enter: { code: 'Enter', keyCode: 13 },
      Tab: { code: 'Tab', keyCode: 9 },
      Escape: { code: 'Escape', keyCode: 27 },
      Backspace: { code: 'Backspace', keyCode: 8 },
      Delete: { code: 'Delete', keyCode: 46 },
      ArrowUp: { code: 'ArrowUp', keyCode: 38 },
      ArrowDown: { code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { code: 'ArrowRight', keyCode: 39 },
      Home: { code: 'Home', keyCode: 36 },
      End: { code: 'End', keyCode: 35 },
      PageUp: { code: 'PageUp', keyCode: 33 },
      PageDown: { code: 'PageDown', keyCode: 34 },
      ' ': { code: 'Space', keyCode: 32 },
    };
    return table[key] ?? { code: key, keyCode: 0 };
  }

  /**
   * 睡眠指定毫秒。
   * @param ms 毫秒数。
   * @returns 到点后 resolve。
   */
  private static sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
