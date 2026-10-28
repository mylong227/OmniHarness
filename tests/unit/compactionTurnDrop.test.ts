/**
 * 压缩组装：超预算时按**整轮**丢弃（2026-10-28）。
 *
 * 缺陷现场：`CompactionComposer.dropOldest` 逐条丢 + 事后 sanitize，会把一个工具轮从中间切开；
 * 实测一次丢掉「user + 整轮工具结果」多条，只剩 pinned + 摘要，模型看不到最新指令/结果。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CompactionComposer } from '../../src/context/compactionComposer.ts';
import { TokenEstimator } from '../../src/context/tokenEstimator.ts';
import type { ModelMessage } from '../../src/ports/model/modelMessage.ts';

test('dropOldest：按整轮丢弃，绝不留下半截工具轮', () => {
  const estimator = new TokenEstimator();
  const system: ModelMessage = { role: 'system', content: 'sys' };
  const oldUser: ModelMessage = { role: 'user', content: 'old task' };
  const call: ModelMessage = {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'a', name: 'read_file', arguments: {} }],
  };
  const tool1: ModelMessage = { role: 'tool', content: 'r1', toolCallId: 'a' };
  const tool2: ModelMessage = { role: 'tool', content: 'r2', toolCallId: 'a' };
  const mid: ModelMessage = { role: 'assistant', content: 'mid answer' };
  const latestUser: ModelMessage = { role: 'user', content: 'latest' };
  const answer: ModelMessage = { role: 'assistant', content: 'answer' };
  const all = [system, oldUser, call, tool1, tool2, mid, latestUser, answer];
  const budget = estimator.estimateMessages([system, latestUser, answer]);

  const out = CompactionComposer.dropOldest(all, budget, estimator);

  assert.strictEqual(out.dropped, 5, '应整轮丢弃 old task 这一轮（5 条）');
  assert.ok(
    out.messages.some((m) => m.content === 'latest'),
    '最新用户指令必须保留',
  );
  assert.ok(
    out.messages.some((m) => m.content === 'answer'),
    '最新答复必须保留',
  );
  assert.ok(!out.messages.some((m) => m.content === 'old task'), '旧轮应被丢弃');
  assert.ok(
    !out.messages.some((m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === 'a')),
    '被丢弃轮次的 assistant(tool_calls) 不得残留',
  );
  assert.ok(
    !out.messages.some((m) => m.role === 'tool' && m.toolCallId === 'a'),
    '被丢弃轮次的 tool 结果不得残留（无 orphan）',
  );
});
