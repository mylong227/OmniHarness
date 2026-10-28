// toast 定时器判据（2026-10-28 前端审计低危）。
//
// ## 缺陷形态
//
// 旧实现用**文案相等**判断「这条定时器该不该隐藏当前 toast」：
// 2.2s 内两次弹出同一句话时，第一条的定时器会把第二条提前熄灭（用户少看一半时间，且第二句
// 可能带着不同的 kind）。
//
// ## 判据
//
// 同一文案在 t=0 与 t=1000ms 各弹一次：A 的定时器到点（t≈2200）后 B 必须仍在；B 自己的定时器
// 到点（t≈3200）才隐藏。
//
// 直跑（web 测试统一入口）：npm run web:test
// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { AppHost } from '../src/ui/controllers/AppController.ts';

const { AppController } = await import('../src/ui/controllers/AppController.ts');

/** 最小状态宿主：AppController 的构造与 showToast 只用到 patch / getState。 */
function makeHost() {
  const state = {
    toastState: { seq: 0, message: '', kind: 'info', visible: false },
  };
  const host = {
    patch(action: Partial<typeof state> | ((prev: typeof state) => Partial<typeof state>)) {
      Object.assign(state, typeof action === 'function' ? action(state) : action);
    },
    getState: () => state,
  };
  return { host: host as unknown as AppHost, state } as {
    host: AppHost;
    state: typeof state;
  };
}

test('toast：相同文案连弹两次，第一条的定时器不得提前熄灭第二条', () => {
  vi.useFakeTimers();
  try {
    const { host, state } = makeHost();
    const ctrl = new AppController(host);
    ctrl.showToast('同一句');
    vi.advanceTimersByTime(1000);
    ctrl.showToast('同一句');
    assert.strictEqual(state.toastState.seq, 2, '每次弹出都必须有自己的序号');
    assert.strictEqual(state.toastState.visible, true);
    // 第一条的 2.2s 定时器到点：它只负责自己那一条（seq=1），不得熄灭当前的 seq=2。
    vi.advanceTimersByTime(1300);
    assert.strictEqual(state.toastState.visible, true, '第二条必须仍在显示（旧实现会在这里被提前熄灭）');
    // 第二条自己的定时器到点才隐藏。
    vi.advanceTimersByTime(1000);
    assert.strictEqual(state.toastState.visible, false, '第二条到点后必须隐藏');
  } finally {
    vi.useRealTimers();
  }
});
