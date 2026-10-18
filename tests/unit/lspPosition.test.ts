import assert from 'node:assert/strict';
import { test } from 'vitest';
import { LspPosition } from '../../src/adapters/lsp/lspPosition.ts';

test('0-based → 1-based：行列同时 +1', () => {
  assert.deepEqual(LspPosition.toOneBased({ line: 0, character: 0 }), { line: 1, character: 1 });
  assert.deepEqual(LspPosition.toOneBased({ line: 12, character: 3 }), { line: 13, character: 4 });
});

test('形状不合法 ⇒ null（不猜坐标）', () => {
  for (const raw of [null, undefined, 'x', 3, {}, { line: 1 }, { line: '1', character: 2 }]) {
    assert.strictEqual(LspPosition.toOneBased(raw), null, JSON.stringify(raw));
  }
});
