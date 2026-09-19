// F8 路由 / 深链：Router 纯函数 + RouteBinding 接线契约测试。
// 验证 parseHash / toHash 往返、非法面板回落、navigate 写入 hash，
// 以及 RouteBinding 的「初始深链还原 / 订阅前进后退 / 退订 / 相同路由立即收口」。
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。

import assert from 'node:assert/strict';
import test from 'node:test';

const { parseHash, toHash, navigate, isValidPane } = await import('../dist/core/Router.js');
const { RouteBinding } = await import('../dist/ui/controllers/RouteBinding.js');

/** 设置全局 location（node 默认无 location）。 */
function withHash(hash) {
  globalThis.location = { hash };
}

/**
 * 安装最小 window 桩（只用到 hashchange 的注册 / 退订）。
 * @returns 触发 hashchange 的函数与当前注册数读取器
 */
function installWindow() {
  const handlers = new Set();
  globalThis.window = {
    addEventListener(type, fn) {
      if (type === 'hashchange') handlers.add(fn);
    },
    removeEventListener(type, fn) {
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
 * @returns 宿主与补丁列表
 */
function makeHost(currentThreadId = null) {
  const patches = [];
  const state = { currentThreadId };
  return {
    patches,
    host: {
      patch(action) {
        const next = typeof action === 'function' ? action(state) : action;
        patches.push(next);
        Object.assign(state, next);
      },
      getState() {
        return state;
      },
    },
  };
}

test('空 hash 回落默认路由（pane=tools, threadId=null）', () => {
  withHash('');
  assert.deepEqual(parseHash(), { pane: 'tools', threadId: null });
});

test('解析 pane + thread 深链', () => {
  withHash('#pane=settings&thread=abc-123');
  assert.deepEqual(parseHash(), { pane: 'settings', threadId: 'abc-123' });
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
  assert.equal(globalThis.location.hash, '#pane=profiles&thread=t-1');
});

test('isValidPane 仅放行已知面板', () => {
  assert.equal(isValidPane('settings'), true);
  assert.equal(isValidPane('bogus'), false);
});

test('RouteBinding.start：还原初始深链（展开右栏 + 载入会话）并订阅哈希变化', () => {
  withHash('#pane=changes&thread=t-deep');
  const win = installWindow();
  const { host, patches } = makeHost(null);
  const opened = [];
  const rb = new RouteBinding(host, (id) => opened.push(id));
  rb.start();

  assert.deepEqual(patches[0], { activePane: 'changes', rightOpen: true }, '深链面板必须落到状态');
  assert.deepEqual(opened, ['t-deep'], '深链会话必须触发载入');
  assert.deepEqual(rb.current(), { pane: 'changes', threadId: 't-deep' });
  assert.equal(win.count(), 1, '必须订阅 hashchange（浏览器前进 / 后退）');

  // 模拟浏览器后退到另一个面板：hash 变化由浏览器派发 hashchange。
  withHash('#pane=memory');
  win.fire();
  assert.deepEqual(patches[patches.length - 1], { activePane: 'memory', rightOpen: true });
  assert.deepEqual(opened, ['t-deep'], '无 thread 的路由不得重复载入会话');

  rb.stop();
  assert.equal(win.count(), 0, 'stop 必须退订 hashchange');
});

test('RouteBinding.start：已在当前会话时深链不重复拉取线程', () => {
  withHash('#pane=tools&thread=t-now');
  installWindow();
  const { host } = makeHost('t-now');
  const opened = [];
  const rb = new RouteBinding(host, (id) => opened.push(id));
  rb.start();
  assert.deepEqual(opened, [], '当前会话与深链一致时不得重复 loadThread');
});

test('RouteBinding：同一会话的重复收口不重复拉取线程，换会话必须拉取', () => {
  withHash('#pane=changes&thread=t1');
  const win = installWindow();
  const { host } = makeHost(null);
  const opened = [];
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

test('RouteBinding.navigate：写 hash；路由未变时立即收口不等 hashchange', () => {
  withHash('#pane=tools');
  const win = installWindow();
  const { host, patches } = makeHost(null);
  const rb = new RouteBinding(host, () => {});
  rb.start();
  patches.length = 0;

  // 面板变化：先写 hash，由 hashchange 收口（不在写入处直接改状态，保证单一收口路径）。
  rb.navigate({ pane: 'file' });
  assert.equal(globalThis.location.hash, '#pane=file');
  assert.deepEqual(patches, [], '变更路由时不得双写状态');
  withHash('#pane=file');
  win.fire();
  assert.deepEqual(patches[patches.length - 1], { activePane: 'file', rightOpen: true });

  // 目标路由与当前一致：浏览器不派发 hashchange，必须立即收口，否则状态与 hash 脱节。
  patches.length = 0;
  rb.navigate({ pane: 'file' });
  assert.deepEqual(patches, [{ activePane: 'file', rightOpen: true }], '相同路由必须直接收口');
});
