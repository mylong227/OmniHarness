// <html lang> 与 UI 语言同步判据（2026-11-01 前端性能批附带修复）。
//
// ## 缺陷形态
//
// index.html 硬编码 `<html lang="zh-CN">`，UI 支持英文（document.title 会随语言切换），
// 但 `documentElement.lang` 从不更新——英文界面下读屏仍按中文发音规则朗读。
//
// ## 修法与判据
//
// i18n 模块是语言变化的单一收口点：`setLocale` / `initLocale` 同步 `syncDocumentLang`。
// 判据钉住三个迁移路径：init 恢复、切到 en、切回 zh。
// 判据直跑：npm run web:test
// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';

const i18n = await import('../src/ui/i18n/i18n.ts');

test('documentElement.lang 跟随 UI 语言（init / 切 en / 切回 zh）', () => {
  i18n.initLocale();
  assert.strictEqual(document.documentElement.lang, 'zh-CN', 'init 后与 index.html 静态初值一致');

  i18n.setLocale('en');
  assert.strictEqual(i18n.getLocale(), 'en');
  assert.strictEqual(document.documentElement.lang, 'en', '切英文后读屏按英文发音');

  i18n.setLocale('zh');
  assert.strictEqual(document.documentElement.lang, 'zh-CN', '切回中文恢复 zh-CN');

  // 还原模块态，避免污染同文件后续用例（localStorage 持久化仅在浏览器态存在，jsdom 无妨）。
  i18n.setLocale('zh');
});
