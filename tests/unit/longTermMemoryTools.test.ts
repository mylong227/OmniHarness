import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/memory/longTermMemory.js';
import { RememberTool, RecallTool } from '../../src/adapters/tool/longTermMemoryTools.js';

/** 内存版长期记忆桩（不落盘，专供工具测试）。 */
function stubStore(): LongTermMemoryPort {
  const facts: MemoryFact[] = [];
  return {
    name: 'stub',
    remember: (fact) => facts.push(fact),
    recall: (query, k) =>
      facts.filter((f) => f.text.toLowerCase().includes(query.toLowerCase())).slice(0, k),
    all: () => facts,
    get: (id) => facts.find((f) => f.id === id),
    update: (id, patch) => {
      const i = facts.findIndex((f) => f.id === id);
      if (i === -1) return false;
      facts[i] = { ...facts[i]!, ...patch };
      return true;
    },
    delete: (id) => {
      const i = facts.findIndex((f) => f.id === id);
      if (i === -1) return false;
      facts.splice(i, 1);
      return true;
    },
    get count() {
      return facts.length;
    },
  };
}

const ctx = { sessionId: 's1', workspaceRoot: '/tmp/x' };

describe('RememberTool / RecallTool', () => {
  it('remember stores and recall retrieves across the store', async () => {
    const store = stubStore();
    const r1 = await new RememberTool(store).handle(
      {
        id: 'c1',
        name: 'remember',
        arguments: { fact: '用户偏好暗色主题', topic: '偏好', importance: 5 },
      },
      ctx,
    );
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(store.count, 1);

    const r2 = await new RecallTool(store).handle(
      { id: 'c2', name: 'recall', arguments: { query: '用户偏好' } },
      ctx,
    );
    assert.strictEqual(r2.ok, true);
    assert.ok((r2.output as string).includes('暗色主题'));
  });

  it('rejects empty fact', async () => {
    const store = stubStore();
    const r = await new RememberTool(store).handle(
      { id: 'c3', name: 'remember', arguments: {} },
      ctx,
    );
    assert.strictEqual(r.ok, false);
    assert.ok(r.error?.includes('fact'));
  });

  it('rejects empty query', async () => {
    const store = stubStore();
    const r = await new RecallTool(store).handle({ id: 'c4', name: 'recall', arguments: {} }, ctx);
    assert.strictEqual(r.ok, false);
  });
});
