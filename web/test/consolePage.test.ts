// 真机判据：设置/功能面板是**全窗口页面**，不是弹窗、也不是夹在会话栏旁边的中栏卡片。
//
// 2026-10-26 用户第二次改版（两张参考图）：
//   ① 设置打开时，应用自己的会话栏/对话/右栏全部让位，只保留控制台自带的左侧导航；
//   ② 关闭后原样回到工作区。
// 所以这里断言的是「整窗接管」：`.csl` 铺满视口、`.body.console-open`、应用左栏不可见、
// 对话输入区不在 DOM；Esc 之后全部恢复。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openStubSession, type CdpSession } from './browserHarness.ts';

/** 与参考图同档的桌面视口。 */
const VIEWPORT = { width: 1440, height: 900 };

/**
 * 读控制台与工作区的状态。
 * @param cdp CDP 会话
 * @returns 状态
 */
function readState(cdp: CdpSession): Promise<{
  hasConsole: boolean;
  role: string | null;
  ariaModal: string | null;
  composer: boolean;
  rightCol: boolean;
  leftCol: boolean;
  leftVisible: boolean;
  bodyConsoleOpen: boolean;
  geom: { x: number; y: number; w: number; h: number } | null;
  viewport: { w: number; h: number };
}> {
  return cdp.evaluate(`(function(){
    var c = document.querySelector('.csl');
    var left = document.querySelector('.col.left');
    var cr = c === null ? null : c.getBoundingClientRect();
    return {
      hasConsole: c !== null,
      role: c === null ? null : c.getAttribute('role'),
      ariaModal: c === null ? null : c.getAttribute('aria-modal'),
      composer: !!document.querySelector('.composer-box'),
      rightCol: !!document.querySelector('.col.right'),
      leftCol: left !== null,
      leftVisible: left !== null && left.getClientRects().length > 0,
      bodyConsoleOpen: !!document.querySelector('.body.console-open'),
      geom: cr === null ? null : { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  })()`) as Promise<{
    hasConsole: boolean;
    role: string | null;
    ariaModal: string | null;
    composer: boolean;
    rightCol: boolean;
    leftCol: boolean;
    leftVisible: boolean;
    bodyConsoleOpen: boolean;
    geom: { x: number; y: number; w: number; h: number } | null;
    viewport: { w: number; h: number };
  }>;
}

test(
  '设置是全窗口页面：整窗接管、左栏让位、非 dialog，Esc 返回工作区',
  { timeout: 120_000 },
  async (t) => {
    const page = await openStubSession(t, VIEWPORT);
    if (page === null) return;
    try {
      const cdp = page.cdp;
      const opened = await cdp.evaluate(`(function(){
        var b = document.querySelector('.side-foot .iconbtn[aria-label="打开设置"]');
        if (b === null) return false;
        b.click();
        return true;
      })()`);
      assert.strictEqual(opened, true, '找不到设置入口');
      assert.ok(await cdp.waitFor("!!document.querySelector('.csl')", 3000), '控制台未出现');

      const state = await readState(cdp);
      assert.strictEqual(state.hasConsole, true);
      assert.strictEqual(state.role, 'region', '全窗口页面不应再声明 dialog');
      assert.strictEqual(state.ariaModal, null, '全窗口页面不得声明 aria-modal');
      assert.strictEqual(state.bodyConsoleOpen, true, 'body 必须进入 console-open 态');
      assert.strictEqual(state.composer, false, '设置打开后对话输入区必须让位');
      assert.strictEqual(state.rightCol, false, '设置打开后右栏必须让位');
      assert.strictEqual(state.leftCol, true, '会话栏保留在 DOM（关闭后立即恢复）');
      assert.strictEqual(state.leftVisible, false, '设置打开时会话栏必须不可见（控制台是唯一左栏）');
      assert.ok(state.geom !== null);
      assert.ok(
        Math.abs(state.geom.w - state.viewport.w) <= 1 &&
          Math.abs(state.geom.h - state.viewport.h) <= 1,
        `控制台必须铺满视口：${String(state.geom.w)}×${String(state.geom.h)} vs ${String(
          state.viewport.w,
        )}×${String(state.viewport.h)}`,
      );

      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await new Promise((r) => setTimeout(r, 400));
      const closed = await readState(cdp);
      assert.strictEqual(closed.hasConsole, false, 'Esc 未关闭控制台');
      assert.strictEqual(closed.composer, true, '关闭后必须恢复对话输入区');
      assert.strictEqual(closed.leftVisible, true, '关闭后会话栏必须恢复可见');
    } finally {
      await page.close();
    }
  },
);
