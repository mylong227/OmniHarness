import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ContextWindowCatalog } from '../../src/context/contextWindowCatalog.ts';

test('CTX-03：Claude 4.6 系列解析为 1M 窗口', () => {
  const catalog = new ContextWindowCatalog();
  assert.strictEqual(catalog.of('claude-opus-4-6'), 1_000_000);
  assert.strictEqual(catalog.of('claude-4.6-sonnet'), 1_000_000);
});

test('CTX-03：旧 Claude 4 仍按 200k，未知模型回退 128k', () => {
  const catalog = new ContextWindowCatalog();
  assert.strictEqual(catalog.of('claude-sonnet-4-20250514'), 200_000);
  assert.strictEqual(catalog.of('totally-unknown-model'), 128_000);
});
