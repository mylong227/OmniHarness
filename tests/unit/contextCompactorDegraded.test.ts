/**
 * 压缩摘要降级不得污染游标（2026-10-28）。
 *
 * 缺陷现场：`CompactionSummarizer.summarize` 在模型失败时返回 7 字占位 `[历史已省略]`，
 * `ContextCompactor.compact` 却把它当正式摘要写进 `state`（`OMNI_COMPACTION_V1 upTo/hash`）。
 * 下一步 `tryReuseState` 前缀命中即零 LLM 复用 ⇒ **一次 429 就能让长会话永久失忆**。
 *
 * 本判据钉住：降级时消息仍可用（本次请求不能炸），但 `state` 必须为空、`degraded` 必须如实上报。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ContextCompactor } from '../../src/context/contextCompactor.ts';
import { CompactionSummarizer } from '../../src/context/compactionSummarizer.ts';
import type { ModelPort } from '../../src/ports/model/model.ts';

/** 必抛模型：模拟 429 / 端点故障。 */
const brokenModel: ModelPort = {
  name: 'broken',
  generate: async () => {
    throw new Error('HTTP 429 Too Many Requests');
  },
};

/** 构造一段有可折叠对话的消息序列。 */
function messages(): readonly { role: 'system' | 'user' | 'assistant'; content: string }[] {
  return [
    { role: 'system', content: '常驻系统提示' },
    { role: 'user', content: '任务：修好构建' },
    { role: 'assistant', content: '先读 a.ts' },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '再读 b.ts' },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '准备改 c.ts' },
  ];
}

test('摘要失败 ⇒ compacted 但 state 不得写回（下次必须重试摘要）', async () => {
  const compactor = new ContextCompactor(brokenModel, { maxTokens: 10, keepRecent: 2 });
  const result = await compactor.compact(messages(), undefined, undefined, true);
  assert.strictEqual(result.compacted, true, '本次请求仍应带上兜底消息，不能炸');
  assert.strictEqual(result.degraded, true, '必须如实上报降级');
  assert.strictEqual(result.state, undefined, '占位摘要绝不能写进游标');
  assert.match(result.summary ?? '', /历史已省略/u);
});

test('摘要可用时仍正常写回游标（不回归）', async () => {
  const good: ModelPort = {
    name: 'good',
    generate: async () => ({ text: '1. 任务目标：修构建\n2. 关键决策：读 a/b/c' }),
  };
  const compactor = new ContextCompactor(good, { maxTokens: 10, keepRecent: 2 });
  const result = await compactor.compact(messages(), undefined, undefined, true);
  assert.strictEqual(result.compacted, true);
  assert.strictEqual(result.degraded, undefined);
  assert.notStrictEqual(result.state, undefined, '可用摘要应写回游标以复用');
});

test('isUnusable：空串与占位都判不可用，正常摘要放行', () => {
  assert.strictEqual(CompactionSummarizer.isUnusable(''), true);
  assert.strictEqual(CompactionSummarizer.isUnusable('   '), true);
  assert.strictEqual(CompactionSummarizer.isUnusable(CompactionSummarizer.PLACEHOLDER), true);
  assert.strictEqual(CompactionSummarizer.isUnusable('结构化摘要'), false);
});
