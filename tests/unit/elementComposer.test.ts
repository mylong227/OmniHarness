// (P3, I-P3-2) 元素组合基元：有限基元周期表，组合合法 = 价互补（valence 相加为 0）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElementComposer } from '../../src/adapters/skill/elementComposer.js';

test('① 周期表为有限基元集（默认 10 元素）', () => {
  const c = new ElementComposer();
  assert.strictEqual(c.elements().length, 10, '有限基元集');
  assert.ok(c.compatible('Na', 'Cl'), 'Na(+1) 与 Cl(-1) 价互补');
  assert.ok(!c.compatible('Na', 'Na'), 'Na 与 Na 价不互补');
});

test('② 合法组合 → 复合能力；非法组合 / 单元素 / 未知元素 → fail-closed', () => {
  const c = new ElementComposer();
  const ok = c.compose(['Na', 'Cl']);
  assert.ok(ok !== undefined, 'Na+Cl 应组合成功');
  assert.strictEqual(ok!.symbol, 'NaCl');
  assert.ok(ok!.tags.includes('mutate') && ok!.tags.includes('scope'), '应合并双方标签');

  assert.strictEqual(c.compose(['Na', 'Na']), undefined, '同价不互补 → 拒绝');
  assert.strictEqual(c.compose(['Na']), undefined, '单元素不构成组合 → 拒绝');
  assert.throws(() => c.compose(['Na', 'Xx']), '未知元素 → 抛错（配置错误 fail-closed）');
});

test('③ 多元素链式组合：全相邻对价互补才合法', () => {
  const c = new ElementComposer();
  // Na(+1)+Cl(-1) 合法，再接 He(0) → Cl(-1)+He(0) 不互补 → 整体拒绝。
  assert.strictEqual(c.compose(['Na', 'Cl', 'He']), undefined, '链中有不互补对 → 拒绝');
  // Mg(+2)+O(-2) 互补，接 Ar(0) → O(-2)+Ar(0) 不互补 → 拒绝。
  assert.strictEqual(c.compose(['Mg', 'O', 'Ar']), undefined);
});
