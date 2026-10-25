import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { AutomationStore } from '../../src/server/services/automationStore.ts';
import { AutomationScheduler } from '../../src/server/services/automationScheduler.ts';

/** 临时存储。 */
function tempStore(now: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'omni-auto-'));
  const store = new AutomationStore(join(dir, 'automations.json'), now);
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('自动化存储：创建/校验/持久化/到期', () => {
  let clock = 0;
  const { store, cleanup } = tempStore(() => clock);
  try {
    const created = store.create({ name: '日报', prompt: '总结今天', intervalMinutes: 5 });
    assert.strictEqual(created.intervalMinutes, 5);
    assert.strictEqual(created.enabled, true);
    assert.strictEqual(store.list().length, 1);
    assert.throws(() => store.create({ name: '', prompt: 'x', intervalMinutes: 5 }));
    assert.throws(() => store.create({ name: 'x', prompt: 'x', intervalMinutes: 1 }));
    assert.strictEqual(store.due(5 * 60_000 - 1).length, 0);
    assert.strictEqual(store.due(5 * 60_000).length, 1);
    clock = 5 * 60_000;
    store.markRun(created.id);
    assert.strictEqual(store.due(5 * 60_000).length, 0);
    store.setEnabled(created.id, false);
    assert.strictEqual(store.due(60 * 60_000).length, 0);
  } finally {
    cleanup();
  }
});

test('自动化调度：到期任务只触发一次，单条失败不拖垮其余', async () => {
  let clock = 0;
  const { store, cleanup } = tempStore(() => clock);
  try {
    const a = store.create({ name: 'a', prompt: 'A', intervalMinutes: 5 });
    const b = store.create({ name: 'b', prompt: 'B', intervalMinutes: 5 });
    const seen: string[] = [];
    const scheduler = new AutomationScheduler(store, async (auto) => {
      seen.push(auto.id);
      if (auto.id === a.id) throw new Error('boom');
    });
    clock = 5 * 60_000;
    await scheduler.tick();
    assert.deepEqual(seen.sort(), [a.id, b.id].sort());
    await scheduler.tick();
    assert.deepEqual(seen.sort(), [a.id, b.id].sort());
  } finally {
    cleanup();
  }
});
