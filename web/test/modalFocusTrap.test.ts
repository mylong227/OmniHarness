// 真机判据：全窗口控制台的焦点行为（它已经不是对话框）。
//
// ## 为什么这条判据反过来了
//
// 2026-10-17 设置是模态：`role="dialog"` + `aria-modal="true"` 却没有焦点陷阱，Tab 会跑到
// 背后界面 ⇒ 当年加了「Tab 必须在框内绕圈」的判据。
// 2026-10-26 用户要求改成**全窗口页面**：控制台占用整个视口，应用会话栏/对话/右栏全部让位。
// 此时它不是对话框，不需要焦点陷阱；但打开时焦点仍应落在当前导航项，关闭后还给触发器。
//
// 判据因此钉三件事：
//   ① 打开后是 region、无 aria-modal，焦点落在当前导航项；
//   ② 不声明 dialog 语义（避免辅助技术以为背后还有可交互界面）；
//   ③ Esc 关闭后 `.csl` 消失，焦点还给「打开设置」触发器。
//
// 夹具：`openStubSession` 注入假 `/rpc` 与假 EventSource，不需要真后端。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openStubSession, type CdpSession } from './browserHarness.ts';

/** 与用户截图同档的桌面视口。 */
const VIEWPORT = { width: 1440, height: 900 };

/** 打开设置的触发器（i18n 两套文案都认，避免判据随语言环境红）。 */
const TRIGGER = 'button[aria-label="打开设置"], button[aria-label="Open settings"]';

/**
 * 读一次控制台与焦点的关系。
 * @param cdp CDP 会话
 * @returns 状态
 */
function readState(cdp: CdpSession): Promise<{
  hasConsole: boolean;
  role: string | null;
  ariaModal: string | null;
  inside: boolean;
  label: string;
}> {
  return cdp.evaluate(`(function(){
    var c = document.querySelector('.csl');
    var active = document.activeElement;
    var label = active === null || active === undefined ? ''
      : (active.getAttribute('aria-label') || active.textContent || active.tagName || '').trim().slice(0, 40);
    return {
      hasConsole: c !== null,
      role: c === null ? null : c.getAttribute('role'),
      ariaModal: c === null ? null : c.getAttribute('aria-modal'),
      inside: c !== null && active !== null && c.contains(active),
      label: label,
    };
  })()`) as Promise<{
    hasConsole: boolean;
    role: string | null;
    ariaModal: string | null;
    inside: boolean;
    label: string;
  }>;
}

test(
  '全窗口控制台：焦点落在导航项，Esc 关闭并归还触发器',
  { timeout: 120_000 },
  async (t) => {
    const page = await openStubSession(t, VIEWPORT);
    if (page === null) return;
    try {
      const cdp = page.cdp;
      const opened = await cdp.evaluate(`(function(){
        var b = document.querySelector('${TRIGGER}');
        if (b === null) return 'no-trigger';
        // 真实鼠标点击会给按钮焦点；程序化 click 不会。先 focus 才能验证"关闭后归还焦点"。
        b.focus();
        b.click();
        return 'ok';
      })()`);
      assert.strictEqual(opened, 'ok', '找不到「打开设置」触发器（aria-label 可能被改）');
      assert.ok(await cdp.waitFor("!!document.querySelector('.csl')", 3000), '控制台未出现');

      const initial = await readState(cdp);
      assert.strictEqual(initial.role, 'region', '嵌入视图必须是 region（不是 dialog）');
      assert.strictEqual(initial.ariaModal, null, '嵌入视图不得声明 aria-modal');
      assert.strictEqual(initial.inside, true, `打开后焦点应在控制台内（当前在「${initial.label}」）`);

      // Esc 关闭并归还焦点。
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await new Promise((r) => setTimeout(r, 400));
      const closed = await readState(cdp);
      assert.strictEqual(closed.hasConsole, false, 'Esc 未关闭控制台');
      const restored = (await cdp.evaluate(
        `(function(){ var a = document.activeElement; if (a === null) return ''; return (a.getAttribute('aria-label') || a.tagName || '').trim(); })()`,
      )) as string;
      assert.match(
        String(restored),
        /打开设置|Open settings/,
        `关闭后焦点没有回到触发器（当前在「${String(restored)}」）`,
      );
    } finally {
      await page.close();
    }
  },
);
