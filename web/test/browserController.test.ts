// BrowserController 的行为判据（2026-10-19）：地址导航 / 状态搬运 / 失败原因。
//
// 用真控制器 + 最小桩状态（与 controllerBindings 的「调用边界」口径一致）：
// 断言的是「输入一段地址后，宿主状态真的变成可渲染的 iframe 目标」。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BrowserController } from '../src/ui/controllers/BrowserController.ts';
import type { AppHost, AppServices } from '../src/ui/controllers/AppController.ts';
import type { BrowserView } from '../src/ui/shared.ts';

/** 造一份最小宿主状态。 */
function makeState(): {
  browser: BrowserView;
  rightCollapsed: boolean;
  rightOpen: boolean;
} {
  return {
    browser: { open: false, active: false, url: '', title: '', reloadKey: 0, error: '' },
    rightCollapsed: true,
    rightOpen: false,
  };
}

/**
 * 造控制器与端口桩。
 * @param state 宿主状态（原地更新）
 * @param port 预览源端口
 * @returns 控制器 / 端口调用次数读取器
 */
function makeController(
  state: ReturnType<typeof makeState>,
  port: number | null,
): { ctrl: BrowserController; calls: { port: number } } {
  const calls = { port: 0 };
  const host = {
    patch(action: Partial<typeof state> | ((prev: typeof state) => Partial<typeof state>)): void {
      Object.assign(state, typeof action === 'function' ? action(state) : action);
    },
    getState: () => state,
  } as unknown as AppHost;
  const services = {
    api: {
      getPreviewPort: async () => {
        calls.port += 1;
        return port;
      },
    },
    toast: () => {},
    navigate: () => {},
  } as unknown as AppServices;
  return { ctrl: new BrowserController(host, services), calls };
}

/** 在定位为 127.0.0.1 的前提下跑一段用例（结束后恢复全局 location）。 */
async function withLoopbackUi(fn: () => Promise<void> | void): Promise<void> {
  const previous = (globalThis as { location?: unknown }).location;
  (globalThis as { location?: unknown }).location = { hostname: '127.0.0.1' };
  try {
    await fn();
  } finally {
    if (previous === undefined) delete (globalThis as { location?: unknown }).location;
    else (globalThis as { location?: unknown }).location = previous;
  }
}

test('open：工作区路径 → 预览源 URL（换主机名 + 端口），并展开右栏', async () => {
  await withLoopbackUi(async () => {
    const state = makeState();
    const { ctrl, calls } = makeController(state, 9000);
    await ctrl.open('examples/demo/index.html');
    assert.strictEqual(state.browser.url, 'http://localhost:9000/examples/demo/index.html');
    assert.strictEqual(state.browser.title, 'index.html');
    assert.strictEqual(state.browser.open, true);
    assert.strictEqual(state.browser.active, true);
    assert.strictEqual(state.browser.error, '');
    assert.strictEqual(state.rightCollapsed, false, '导航后必须展开右栏');
    assert.strictEqual(state.rightOpen, true);
    assert.strictEqual(calls.port, 1);
  });
});

test('open：绝对网址直接打开（不为它去问预览端口）', async () => {
  await withLoopbackUi(async () => {
    const state = makeState();
    const { ctrl, calls } = makeController(state, 9000);
    await ctrl.open('http://localhost:5173/');
    assert.strictEqual(state.browser.url, 'http://localhost:5173/');
    assert.strictEqual(state.browser.title, 'localhost:5173');
    assert.strictEqual(calls.port, 0, '公网/已启动服务的地址不需要预览源');
  });
});

test('open：非法协议保留原地址但给出可读失败原因（用户可直接改地址栏）', async () => {
  await withLoopbackUi(async () => {
    const state = makeState();
    const { ctrl } = makeController(state, 9000);
    await ctrl.open('http://localhost:5173/');
    await ctrl.open('file:///C:/Windows/win.ini');
    assert.strictEqual(state.browser.url, 'http://localhost:5173/', '失败不得把当前页清空');
    assert.match(state.browser.error, /地址格式无法识别/u);
    assert.strictEqual(state.browser.active, true);
  });
});

test('reload / close / show：重载只加代数，关闭保留地址，show 重新激活', async () => {
  await withLoopbackUi(async () => {
    const state = makeState();
    const { ctrl } = makeController(state, 9000);
    await ctrl.open('index.html');
    const before = state.browser.reloadKey;
    ctrl.reload();
    assert.strictEqual(state.browser.reloadKey, before + 1);
    ctrl.close();
    assert.strictEqual(state.browser.open, false);
    assert.strictEqual(state.browser.active, false);
    assert.strictEqual(state.browser.url, 'http://localhost:9000/index.html', '关闭标签不清地址');
    ctrl.show();
    assert.strictEqual(state.browser.open, true);
    assert.strictEqual(state.browser.active, true);
  });
});
