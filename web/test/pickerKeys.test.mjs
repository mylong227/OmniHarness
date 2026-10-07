// 文件夹选择器按键判定的门禁（纯逻辑，零 DOM）。
//
// ## 缺陷形态（2026-10-07 用户报「新建文件夹不能改名，输入就直接退出了新建文件夹」）
//
// 旧实现把按键判定内联在 FolderPicker 的 window keydown 里，新建态分支**没判断键名**：
// 处于新建态时按任何键都退出新建 ⇒ 命名框里敲不进一个字母。
//
// ## 判据（对已知坏输入变红）
//
// 字母 / 数字 / 中文等普通键在新建态必须返回 null（不退新建）；Esc 新建态退新建、浏览态关弹窗；
// Enter 仅在新建态确认；输入法组合期（isComposing）一律放行。
//
// 直跑：node --test web/test/pickerKeys.test.mjs（模型零依赖，无需构建也可跑，但统一先 web:build）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

createRuntime().install();
const { PickerKeys } = await import('../dist/ui/models/PickerKeys.js');

test('普通输入键在新建态不产生任何指令（「一输入就退出新建」的回归判据）', () => {
  for (const key of ['a', 'Z', '1', '-', '中文', ' ', 'Backspace', 'ArrowLeft', 'Tab']) {
    assert.strictEqual(
      PickerKeys.resolve(key, { creating: true, composing: false }),
      null,
      `新建态按「${key}」必须当作普通输入放行，不得退出新建`,
    );
  }
});

test('Esc：新建态退新建（就近取消），浏览态才关整个弹窗', () => {
  assert.strictEqual(PickerKeys.resolve('Escape', { creating: true, composing: false }), 'exit-create');
  assert.strictEqual(PickerKeys.resolve('Escape', { creating: false, composing: false }), 'close-picker');
});

test('Enter：仅新建态确认创建；浏览态 Enter 不是指令', () => {
  assert.strictEqual(PickerKeys.resolve('Enter', { creating: true, composing: false }), 'confirm-create');
  assert.strictEqual(PickerKeys.resolve('Enter', { creating: false, composing: false }), null);
});

test('输入法组合期（isComposing）：Enter / Esc / 字母全部放行给输入法', () => {
  assert.strictEqual(PickerKeys.resolve('Enter', { creating: true, composing: true }), null);
  assert.strictEqual(PickerKeys.resolve('Escape', { creating: true, composing: true }), null);
  assert.strictEqual(PickerKeys.resolve('a', { creating: true, composing: true }), null);
});
