/**
 * F9：容量分解的单条消息缓存必须与「每次重算」逐值一致；原地改 content 后不得返回旧值。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ContextBreakdownEstimator } from '../../src/context/contextBreakdownEstimator.ts';
import type { ModelMessage } from '../../src/ports/model/model.ts';

const inputOf = (messages: readonly ModelMessage[]) => ({
  messages,
  tools: [],
  baseFragmentCount: 1,
  windowTokens: 128_000,
});

test('ContextBreakdownEstimator：warm 结果与冷算一致', () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'hello world' },
    { role: 'assistant', content: 'answer '.repeat(100) },
  ];
  const warm = new ContextBreakdownEstimator();
  const first = warm.estimate(inputOf(messages));
  const second = warm.estimate(inputOf(messages));
  assert.deepStrictEqual(second, first);
  const cold = new ContextBreakdownEstimator().estimate(inputOf(messages));
  assert.deepStrictEqual(second, cold);
});

test('ContextBreakdownEstimator：原地改 content 后必须重算', () => {
  const message = { role: 'user', content: 'short' } as ModelMessage & { content: string };
  const estimator = new ContextBreakdownEstimator();
  const before = estimator.estimate(inputOf([message])).usedTokens;
  message.content = 'much longer content '.repeat(200);
  const after = estimator.estimate(inputOf([message])).usedTokens;
  assert.ok(after > before, `改长后 token 必须增加（${before} → ${after}）`);
  assert.deepStrictEqual(
    estimator.estimate(inputOf([message])),
    new ContextBreakdownEstimator().estimate(inputOf([message])),
  );
});
