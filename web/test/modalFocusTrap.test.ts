// 真机判据：设置模态必须**真的圈住焦点**（WCAG 2.4.3 / 对话框模式）。
//
// ## 为什么需要它
//
// 设置模态此前只有 `role="dialog"` + `aria-modal="true"` + Esc，**没有焦点陷阱**：
// 打开后按 Tab 会一路走出模态、落到左栏会话列表与输入框上。纯键盘与屏幕阅读器用户
// 因此会"在模态开着的时候操作到背后的界面"——`aria-modal` 只是告诉辅助技术"别管背后"，
// 它**不会**替你把焦点关住。
//
// ## 为什么这条必须是真机（而不是纯函数判据）
//
// 绕圈计算已由 `web/test/focusTrap.test.mjs`（纯函数、零 DOM）覆盖。真正会出问题的是**接线**：
// ref 有没有挂到模态根、window 级 keydown 有没有接管 Tab、可聚焦元素集合对不对
//（禁用按钮、折叠面板里的隐藏按钮都不该进环）。这些只有真 DOM 能证明。
//
// 夹具说明：`stubHtmlCdp` 会注入假 `/rpc` 与假 EventSource，因此**不需要后端**就能
// 渲染完整工作台（与 shellDensity / popoverFit 等判据同一套装配）。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openStubSession, CdpSession } from './browserHarness.ts';

/** 真机窗口尺寸（与用户截图同档；设置模态宽度按此布局）。 */
const VIEWPORT = { width: 1440, height: 900 };

/** 打开设置的触发器（i18n 两套文案都认，避免判据随语言环境红）。 */
const TRIGGER = 'button[aria-label="打开设置"], button[aria-label="Open settings"]';

/**
 * 按一次 Tab（或 Shift+Tab）。
 * @param {object} cdp CDP 会话
 * @param {boolean} backward 是否反向
 * @returns {Promise<void>} 无
 */
async function pressTab(cdp: CdpSession, backward: boolean) {
  const base = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    ...base,
    modifiers: backward ? 8 : 0,
  });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/**
 * 读一次焦点状态。
 * @param cdp CDP 会话
 * @returns 状态
 */
function readFocus(cdp: CdpSession): Promise<{
  hasModal: boolean;
  inside: boolean;
  onRoot: boolean;
  label: string;
  focusables: number;
}> {
  // evaluate 返回 unknown，按页面脚本真实返回形状收窄（例外 a）
  return cdp.evaluate(`(function(){
    var sp = document.querySelector('.sp');
    if (sp === null) return { hasModal:false, inside:false, onRoot:false, label:'', focusables:0 };
    var sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    var list = sp.querySelectorAll(sel);
    var active = document.activeElement;
    var label = active === null || active === undefined ? ''
      : (active.getAttribute('aria-label') || active.textContent || active.tagName || '').trim().slice(0, 40);
    return {
      hasModal: true,
      inside: sp.contains(active),
      onRoot: active === sp,
      label: label,
      focusables: list.length,
    };
  })()`) as Promise<{
    hasModal: boolean;
    inside: boolean;
    onRoot: boolean;
    label: string;
    focusables: number;
  }>;
}

/** 关掉模态（Esc）。 @param {object} cdp CDP 会话 @returns {Promise<void>} 无 */
async function pressEscape(cdp: CdpSession) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await new Promise((r) => setTimeout(r, 400));
}

test('设置模态：打开即接管焦点，Tab/Shift+Tab 都出不去，Esc 关闭并把焦点还给触发器', { timeout: 120_000 }, async (t) => {
  const page = await openStubSession(t, { stub: '_modal-focus-trap.html', ...VIEWPORT });
  if (page === null) return;
  try {
    const cdp = page.cdp;

    // ① 打开：必须先把焦点移进模态（不能留在背后的触发器上）。
    const opened = await cdp.evaluate(
      `(function(){
        var b = document.querySelector('${TRIGGER}');
        if (b === null) return 'no-trigger';
        // 先 focus 再 click：真实鼠标点击会给按钮焦点，而程序化 .click() 不会。
        // 不这么做，关闭后的"焦点归位"会因为 opener 是 BODY 而看起来失效（实测踩到过）。
        b.focus();
        b.click();
        return 'ok';
      })()`,
    );
    assert.strictEqual(opened, 'ok', '找不到「打开设置」触发器（aria-label 可能被改）');
    await new Promise((r) => setTimeout(r, 500));

    const initial = await readFocus(cdp);
    assert.ok(initial.hasModal, '点「设置」后模态未出现（.sp 不存在）');
    assert.ok(
      initial.focusables >= 5,
      `模态内可聚焦元素过少（${String(initial.focusables)}），焦点陷阱形同虚设`,
    );
    assert.ok(
      initial.inside,
      `打开后焦点没有移进模态（当前在「${initial.label}」）⇒ 键盘用户仍停在背后的界面上`,
    );

    // ② 正向 Tab 走满两圈：任何一步都不许跑出模态。
    for (let round = 0; round < 2; round += 1) {
      for (let i = 0; i < initial.focusables; i += 1) {
        await pressTab(cdp, false);
        const at = await readFocus(cdp);
        assert.ok(
          at.inside,
          `第 ${String(round + 1)} 圈第 ${String(i + 1)} 次 Tab 后焦点跑出模态（当前在「${at.label}」）`,
        );
      }
    }

    // ③ 反向 Shift+Tab 同样不许跑出去（首尾回绕最常见在这里出问题）。
    for (let i = 0; i < initial.focusables; i += 1) {
      await pressTab(cdp, true);
      const at = await readFocus(cdp);
      assert.ok(
        at.inside,
        `第 ${String(i + 1)} 次 Shift+Tab 后焦点跑出模态（当前在「${at.label}」）`,
      );
    }

    // ④ Esc 关闭，并把焦点还给打开它的那个按钮。
    await pressEscape(cdp);
    const closed = await readFocus(cdp);
    assert.strictEqual(closed.hasModal, false, 'Esc 未关闭设置模态');
    const restored = await cdp.evaluate(
      `(function(){ var a = document.activeElement; if (a === null) return ''; return (a.getAttribute('aria-label') || a.tagName || '').trim(); })()`,
    );
    assert.match(
      String(restored),
      /打开设置|Open settings/,
      `关闭后焦点没有回到触发器（当前在「${String(restored)}」）⇒ 键盘用户会丢失位置感`,
    );
  } finally {
    await page.close();
  }
});
