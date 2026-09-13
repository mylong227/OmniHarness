// 快捷键执行器单测（零 DOM 依赖）：锁死「动作 → 回调」映射。
// 运行方式：web:build 编译出 web/dist 后，node --test web/test/*.test.mjs 直跑。

import assert from 'node:assert/strict';
import test from 'node:test';
import { ShortcutActions } from '../dist/ui/controllers/ShortcutActions.js';

/** 构造记录调用的桩回调集合。 */
const makeHandlers = () => {
  const calls = [];
  const handlers = {
    togglePalette: () => calls.push('palette'),
    newSession: () => calls.push('newSession'),
    toggleLeft: () => calls.push('toggleLeft'),
    toggleRight: () => calls.push('toggleRight'),
    toggleTheme: () => calls.push('toggleTheme'),
  };
  return { calls, handlers };
};

test('ShortcutActions：每个动作触发且仅触发对应回调', () => {
  for (const action of ['palette', 'newSession', 'toggleLeft', 'toggleRight', 'toggleTheme']) {
    const { calls, handlers } = makeHandlers();
    new ShortcutActions(handlers).run(action);
    assert.deepEqual(calls, [action], `${action} 应只触发同名回调`);
  }
});

test('ShortcutActions：未识别动作不触发任何回调（fail-closed）', () => {
  const { calls, handlers } = makeHandlers();
  new ShortcutActions(handlers).run('unknown');
  assert.deepEqual(calls, []);
});
