import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ContextCompactor } from '../../src/context/contextCompactor.ts';
import type { ModelPort } from '../../src/ports/model/model.ts';

const summarizer: ModelPort = {
  name: 'sum',
  generate: async () => ({ text: '结构化摘要：任务目标/文件/进度' }),
};

test('CTX-04：force=true 时即便远低于阈值也强制折叠', async () => {
  const compactor = new ContextCompactor(summarizer, { maxTokens: 1_000_000, keepRecent: 2 });
  const messages = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: '任务' },
    { role: 'assistant' as const, content: '已读 a.ts' },
    { role: 'user' as const, content: '继续' },
    { role: 'assistant' as const, content: '已读 b.ts' },
    { role: 'user' as const, content: '继续' },
  ];
  const normal = await compactor.compact(messages);
  assert.strictEqual(normal.compacted, false);
  const forced = await compactor.compact(messages, undefined, undefined, true);
  assert.strictEqual(forced.compacted, true);
  assert.ok(forced.summary !== undefined && forced.summary.includes('结构化摘要'));
});
