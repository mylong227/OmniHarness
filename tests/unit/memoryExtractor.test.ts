import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  LongTermMemoryPort,
  MemoryFact,
  ModelPort,
  ModelOutput,
  ModelRequest,
  SessionEvent,
} from '../../src/ports/index.js';
import { MemoryExtractor } from '../../src/adapters/memory/memoryExtractor.js';

/** 内存版长期记忆桩。 */
function stubStore(): LongTermMemoryPort {
  const facts: MemoryFact[] = [];
  return {
    name: 'stub',
    remember: (fact) => facts.push(fact),
    recall: (query, k) => facts.filter((f) => f.text.includes(query)).slice(0, k),
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

/** 桩模型：固定返回给定 JSON 文本。 */
function stubModel(text: string): ModelPort {
  return {
    name: 'stub-model',
    generate: async (_req: ModelRequest): Promise<ModelOutput> => ({ text }),
  };
}

/** 构造一条 user 事件。 */
function ev(content: string): SessionEvent {
  return {
    id: content,
    sessionId: 's1',
    type: 'user',
    timestamp: new Date().toISOString(),
    payload: { content },
  } as SessionEvent;
}

describe('MemoryExtractor', () => {
  it('extracts durable facts and dedupes against existing', async () => {
    const store = stubStore();
    store.remember({
      id: 'x',
      text: 'already known fact',
      importance: 3,
      createdAt: new Date().toISOString(),
      sessionId: 's0',
      source: 'tool',
    });
    const model = stubModel('["新事实A","新事实B","already known fact"]');
    const ex = new MemoryExtractor(model, store);
    const added = await ex.consolidate(
      [ev('用户说 新事实A 新事实B'), ev('already known fact')],
      's1',
    );
    assert.strictEqual(added, 2);
    assert.strictEqual(store.count, 3);
  });

  it('only processes fresh events via internal cursor', async () => {
    const store = stubStore();
    const model = stubModel('["A"]');
    const ex = new MemoryExtractor(model, store);
    await ex.consolidate([ev('a')], 's1');
    assert.strictEqual(store.count, 1);
    // 第二次只处理增量事件 'b'（'a' 已蒸馏过）。
    const model2 = stubModel('["B"]');
    const ex2 = new MemoryExtractor(model2, store);
    const added = await ex2.consolidate([ev('a'), ev('b')], 's1');
    assert.strictEqual(added, 1);
    assert.strictEqual(store.count, 2);
  });

  it('returns 0 when transcript empty (no model call needed)', async () => {
    const store = stubStore();
    let called = false;
    const model: ModelPort = {
      name: 'stub',
      generate: async () => {
        called = true;
        return { text: '[]' };
      },
    };
    const ex = new MemoryExtractor(model, store);
    const added = await ex.consolidate(
      [{ id: '1', sessionId: 's', type: 'tool_call', timestamp: '', payload: {} } as SessionEvent],
      's1',
    );
    assert.strictEqual(added, 0);
    assert.strictEqual(called, false);
  });
});
