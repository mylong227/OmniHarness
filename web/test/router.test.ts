// F8 路由 / 深链：Router 纯函数 + RouteBinding 接线契约测试。
// 验证 parseHash / toHash 往返、非法面板回落、navigate 写入 hash，
// 以及 RouteBinding 的「初始深链还原 / 订阅前进后退 / 退订 / 相同路由立即收口」。
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。

import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AppHost, AppState } from '../src/ui/controllers/AppController.ts';

const { parseHash, toHash, navigate, isValidPane } = await import('../src/core/Router.ts');
const { RouteBinding } = await import('../src/ui/controllers/RouteBinding.ts');

/** 设置全局 location（node 默认无 location）。 */
function withHash(hash: string): void {
  // 桩只提供 RouteBinding 实际读写的 hash 字段（按边界约定断言为 Location）。
  globalThis.location = { hash } as Location;
}

/**
 * 安装最小 window 桩（只用到 hashchange 的注册 / 退订）。
 * @returns 触发 hashchange 的函数与当前注册数读取器
 */
function installWindow() {
  const handlers = new Set<() => void>();
  // node 环境无 window；桩只提供 hashchange 的注册 / 退订两个成员（边界处收窄，同 hooksStub 口径）。
  (globalThis as unknown as Record<string, unknown>).window = {
    addEventListener(type: string, fn: () => void) {
      if (type === 'hashchange') handlers.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      if (type === 'hashchange') handlers.delete(fn);
    },
  };
  return {
    fire() {
      for (const fn of handlers) fn();
    },
    count() {
      return handlers.size;
    },
  };
}

/**
 * 构造 RouteBinding 用的状态宿主桩。
 * @param currentThreadId 预设的当前会话 id
 * @returns 宿主与补丁列表
 */
function makeHost(currentThreadId: string | null = null) {
  const patches: Partial<AppState>[] = [];
  const state = { currentThreadId };
  return {
    patches,
    host: {
      patch(action: Partial<AppState> | ((prev: AppState) => Partial<AppState>)) {
        // 桩 state 只承载 RouteBinding 读取的字段（currentThreadId），按边界约定断言为完整 AppState。
        const next = typeof action === 'function' ? action(state as AppState) : action;
        patches.push(next);
        Object.assign(state, next);
      },
      // 同上：桩只覆盖被测代码实际读取的字段，按边界约定断言（避免为 69 个 hook 造全量 AppState）。
      getState(): AppState {
        return state as AppState;
      },
    } as AppHost,
  };
}

test('空 hash 回落默认路由（pane=tools, threadId=null）', () => {
  withHash('');
  assert.deepEqual(parseHash(), { pane: 'tools', threadId: null });
});

test('解析 pane + thread 深链', () => {
  withHash('#pane=profiles&thread=abc-123');
  assert.deepEqual(parseHash(), { pane: 'profiles', threadId: 'abc-123' });
});

test('settings 不再是合法 pane：旧深链安全落回默认面板', () => {
  // 2026-10-17：设置从右栏面板改为模态（左栏页脚按钮 + 居中模态）。
  // 旧书签 `#pane=settings` 必须**明确落回 tools**，而不是"解析成合法但渲染空白"——
  // 后者会让用户以为是面板坏了，实际是入口搬家了。
  withHash('#pane=settings&thread=abc-123');
  assert.deepEqual(parseHash(), { pane: 'tools', threadId: 'abc-123' });
});

test('toHash 与 parseHash 往返一致', () => {
  const route = { pane: 'changes', threadId: 'sess-9' };
  withHash(toHash(route));
  assert.deepEqual(parseHash(), route);
});

test('thread 为空串时归一为 null', () => {
  withHash('#pane=metrics&thread=');
  assert.deepEqual(parseHash(), { pane: 'metrics', threadId: null });
});

test('非法面板标识回落 tools', () => {
  withHash('#pane=not_a_pane&thread=x');
  assert.deepEqual(parseHash(), { pane: 'tools', threadId: 'x' });
});

test('navigate 写入 location.hash', () => {
  withHash('');
  navigate({ pane: 'profiles', threadId: 't-1' });
  assert.strictEqual(globalThis.location.hash, '#pane=profiles&thread=t-1');
});

test('isValidPane 仅放行已知面板', () => {
  assert.strictEqual(isValidPane('profiles'), true);
  assert.strictEqual(isValidPane('vault'), true);
  // 设置已改为模态（2026-10-17）：它不再是面板，故不再是合法 pane。
  assert.strictEqual(isValidPane('settings'), false, 'settings 已移出面板注册表，不该再被放行');
  assert.strictEqual(isValidPane('bogus'), false);
});

test('RouteBinding.start：还原初始深链（展开右栏 + 载入会话）并订阅哈希变化', () => {
  withHash('#pane=changes&thread=t-deep');
  const win = installWindow();
  const { host, patches } = makeHost(null);
  const opened: string[] = [];
  const rb = new RouteBinding(host, (id) => opened.push(id));
  rb.start();

  assert.deepEqual(
    patches[0],
    { activePane: 'changes', rightOpen: true, rightCollapsed: false, panelModalOpen: true },
    '深链面板必须落到状态，并复位桌面端收起偏好',
  );
  assert.deepEqual(opened, ['t-deep'], '深链会话必须触发载入');
  assert.deepEqual(rb.current(), { pane: 'changes', threadId: 't-deep' });
  assert.strictEqual(win.count(), 1, '必须订阅 hashchange（浏览器前进 / 后退）');

  // 模拟浏览器后退到另一个面板：hash 变化由浏览器派发 hashchange。
  withHash('#pane=memory');
  win.fire();
  assert.deepEqual(patches[patches.length - 1], {
    activePane: 'memory',
    rightOpen: true,
    rightCollapsed: false,
    panelModalOpen: true,
  });
  assert.deepEqual(opened, ['t-deep'], '无 thread 的路由不得重复载入会话');

  rb.stop();
  assert.strictEqual(win.count(), 0, 'stop 必须退订 hashchange');
});

test('RouteBinding.start：已在当前会话时深链不重复拉取线程', () => {
  withHash('#pane=tools&thread=t-now');
  installWindow();
  const { host } = makeHost('t-now');
  const opened: string[] = [];
  const rb = new RouteBinding(host, (id) => opened.push(id));
  rb.start();
  assert.deepEqual(opened, [], '当前会话与深链一致时不得重复 loadThread');
});

test('RouteBinding：同一会话的重复收口不重复拉取线程，换会话必须拉取', () => {
  withHash('#pane=changes&thread=t1');
  const win = installWindow();
  const { host } = makeHost(null);
  const opened: string[] = [];
  const rb = new RouteBinding(host, (id) => opened.push(id));
  rb.start();
  assert.deepEqual(opened, ['t1'], '深链会话必须拉取一次');

  // loadThread 完成后自身会 navigate({ threadId: 't1' })：哈希未变 ⇒ 立即收口，不得再次拉取。
  rb.navigate({ threadId: 't1' });
  assert.deepEqual(opened, ['t1'], '同一会话不得重复 loadThread（否则每次深链多打一次 threads.get）');

  // 浏览器后退到另一面板但同一会话：仍不重复拉取。
  withHash('#pane=memory&thread=t1');
  win.fire();
  assert.deepEqual(opened, ['t1']);

  // 换成另一会话：必须拉取。
  withHash('#pane=memory&thread=t2');
  win.fire();
  assert.deepEqual(opened, ['t1', 't2']);

  // 回到无会话路由后再进入同一会话：必须重新拉取（去重状态已重置）。
  withHash('#pane=memory');
  win.fire();
  withHash('#pane=memory&thread=t1');
  win.fire();
  assert.deepEqual(opened, ['t1', 't2', 't1']);
});

test('RouteBinding：只换会话不重开已关闭的面板模态（点会话行不弹配置集）', () => {
  withHash('#pane=profiles&thread=t1');
  const win = installWindow();
  const { host, patches } = makeHost('t1');
  const rb = new RouteBinding(host, () => {});
  rb.start();
  // 用户关掉配置集模态；路由仍保留 pane=profiles。
  host.patch({ panelModalOpen: false });
  patches.length = 0;

  // loadThread 只 navigate threadId：沿用 profiles pane，但不得把模态重新打开。
  rb.navigate({ threadId: 't2' });
  withHash('#pane=profiles&thread=t2');
  win.fire();
  assert.ok(
    !patches.some((p) => p.panelModalOpen === true),
    '只换会话时不得重开配置集/功能面板',
  );
});

test('RouteBinding.navigate：写 hash；路由未变时立即收口不等 hashchange', () => {
  withHash('#pane=tools');
  const win = installWindow();
  const { host, patches } = makeHost(null);
  const rb = new RouteBinding(host, () => {});
  rb.start();
  patches.length = 0;

  // 面板变化：先写 hash，由 hashchange 收口（不在写入处直接改状态，保证单一收口路径）。
  rb.navigate({ pane: 'file' });
  assert.strictEqual(globalThis.location.hash, '#pane=file');
  assert.deepEqual(patches, [], '变更路由时不得双写状态');
  withHash('#pane=file');
  win.fire();
  assert.deepEqual(patches[patches.length - 1], {
    activePane: 'file',
    rightOpen: true,
    rightCollapsed: false,
  });

  // 目标路由与当前一致：浏览器不派发 hashchange，必须立即收口，否则状态与 hash 脱节。
  patches.length = 0;
  rb.navigate({ pane: 'file' });
  assert.deepEqual(
    patches,
    [{ activePane: 'file', rightCollapsed: false, rightOpen: true }],
    '相同路由必须直接收口',
  );
});
