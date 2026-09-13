// 全局快捷键解析器单测（零 DOM 依赖）：锁死「按键 → 动作」映射，并验证文案与绑定同源。
// 运行方式：web:build 编译出 web/dist 后，node --test web/test/*.test.mjs 直跑。

import assert from 'node:assert/strict';
import test from 'node:test';
import { KeyboardShortcuts } from '../dist/ui/models/KeyboardShortcuts.js';

const ks = new KeyboardShortcuts();

/** 构造按键信息（默认无修饰键）。 */
const key = (k, mods = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

test('KeyboardShortcuts：Ctrl/Cmd+P 与 Ctrl/Cmd+K 都唤起命令面板', () => {
  assert.equal(ks.resolve(key('p', { ctrlKey: true })), 'palette');
  assert.equal(ks.resolve(key('P', { metaKey: true })), 'palette');
  assert.equal(ks.resolve(key('k', { ctrlKey: true })), 'palette');
  assert.equal(ks.resolve(key('K', { metaKey: true })), 'palette');
});

test('KeyboardShortcuts：裸键一律放行（不劫持正文输入）', () => {
  for (const k of ['p', 'k', 'b', 'n', 'e', 'l']) {
    assert.equal(ks.resolve(key(k)), null, `裸键 ${k} 不应命中`);
  }
});

test('KeyboardShortcuts：Shift 组合与无 Shift 组合互不串台', () => {
  assert.equal(ks.resolve(key('b', { ctrlKey: true })), 'toggleLeft');
  assert.equal(
    ks.resolve(key('B', { ctrlKey: true, shiftKey: true })),
    null,
    'Shift+B 不命中 toggleLeft',
  );
  assert.equal(ks.resolve(key('e', { ctrlKey: true })), null, '无 Shift 的 E 不命中 toggleRight');
  assert.equal(ks.resolve(key('e', { ctrlKey: true, shiftKey: true })), 'toggleRight');
  assert.equal(ks.resolve(key('L', { metaKey: true, shiftKey: true })), 'toggleTheme');
  assert.equal(ks.resolve(key('l', { metaKey: true })), null, '无 Shift 的 L 不命中 toggleTheme');
});

test('KeyboardShortcuts：Ctrl/Cmd+N 新建会话', () => {
  assert.equal(ks.resolve(key('n', { ctrlKey: true })), 'newSession');
  assert.equal(ks.resolve(key('N', { metaKey: true })), 'newSession');
});

test('KeyboardShortcuts：未绑定按键返回 null', () => {
  assert.equal(ks.resolve(key('q', { ctrlKey: true })), null);
  assert.equal(ks.resolve(key(' ', { ctrlKey: true })), null);
});

test('KeyboardShortcuts：每个动作都有非空文案（提示与绑定同源，不漂移）', () => {
  for (const action of ['palette', 'newSession', 'toggleLeft', 'toggleRight', 'toggleTheme']) {
    assert.ok(ks.label(action).length > 0, `${action} 应有快捷键文案`);
  }
});
