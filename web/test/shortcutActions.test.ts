// 快捷键执行器单测（零 DOM 依赖）：锁死「动作 → 回调」映射。
// 运行方式：web:build 编译出 web/dist 后，node --test web/test/*.test.mjs 直跑。

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ShortcutActions } from '../src/ui/controllers/ShortcutActions.ts';
import type { ShortcutAction } from '../src/ui/models/KeyboardShortcuts.ts';

/** 构造记录调用的桩回调集合。 */
const makeHandlers = () => {
  const calls: string[] = [];
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
  for (const action of ['palette', 'newSession', 'toggleLeft', 'toggleRight', 'toggleTheme'] as const) {
    const { calls, handlers } = makeHandlers();
    new ShortcutActions(handlers).run(action);
    assert.deepEqual(calls, [action], `${action} 应只触发同名回调`);
  }
});

test('ShortcutActions：未识别动作不触发任何回调（fail-closed）', () => {
  const { calls, handlers } = makeHandlers();
  // 本判据故意喂非法动作验证 fail-closed；在调用边界按 ShortcutAction 收窄（例外 a）
  new ShortcutActions(handlers).run('unknown' as ShortcutAction);
  assert.deepEqual(calls, []);
});
