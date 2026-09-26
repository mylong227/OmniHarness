import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HeatEquationAnnealer } from '../../src/adapters/memory/heatEquationAnnealer.js';
import type { MemoryFact, LongTermMemoryPort } from '../../src/ports/memory/longTermMemory.js';

test('S13：退火一步只落盘一次（批量入口），不再逐条整文件重写', () => {
  // 回归（2026-09-26 审计 S13）：退火器一步会更新上千条事实的重要性，而 update 每次都做
  // 「整文件重写 + 重加密」⇒ O(n²) 同步 IO 把事件循环整段钉住。
  const facts: MemoryFact[] = Array.from({ length: 40 }, (_, i) => ({
    id: `f${String(i)}`,
    text: `fact ${String(i)} about token budget`,
    importance: 5,
    createdAt: new Date().toISOString(),
    sessionId: 's1',
    source: 'tool' as const,
  }));
  let updateCalls = 0;
  let updateManyCalls = 0;
  let persisted = 0;
  const memory: LongTermMemoryPort = {
    name: 'stub',
    remember: () => undefined,
    recall: () => [],
    all: () => facts,
    count: facts.length,
    get: (id: string) => facts.find((f) => f.id === id),
    update: () => {
      updateCalls += 1;
      persisted += 1;
      return true;
    },
    updateMany: (patches: readonly { id: string; patch: { importance: number } }[]) => {
      updateManyCalls += 1;
      persisted += 1;
      return patches.length;
    },
    delete: () => false,
  };
  const annealer = new HeatEquationAnnealer(memory, { maxFacts: 40 });
  const report = annealer.anneal();
  assert.ok(report.facts > 10, `前置条件：应处理若干事实，实际 ${String(report.facts)}`);
  assert.strictEqual(updateCalls, 0, '有批量入口时不得再逐条 update');
  assert.strictEqual(updateManyCalls, 1, '一步退火只应落盘一次');
  assert.strictEqual(persisted, 1, '落盘次数必须是 1（旧实现 = 事实条数）');
});

test('S13：端口未提供批量入口时按 update 逐条回落（契约向后兼容）', () => {
  const facts: MemoryFact[] = Array.from({ length: 6 }, (_, i) => ({
    id: `g${String(i)}`,
    text: `g ${String(i)}`,
    importance: 5,
    createdAt: new Date().toISOString(),
    sessionId: 's1',
    source: 'tool' as const,
  }));
  let updateCalls = 0;
  const memory: LongTermMemoryPort = {
    name: 'stub',
    remember: () => undefined,
    recall: () => [],
    all: () => facts,
    count: facts.length,
    get: (id: string) => facts.find((f) => f.id === id),
    update: () => {
      updateCalls += 1;
      return true;
    },
    delete: () => false,
  };
  new HeatEquationAnnealer(memory, { maxFacts: 6 }).anneal();
  assert.ok(updateCalls > 0, '无批量入口时必须逐条回落（不得静默不写）');
});
