/**
 * LongMemEval 代理评分判据。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { LongMemEval, type LongMemEvalCase } from '../../src/eval/longMemEval.ts';

const CASES: LongMemEvalCase[] = [
  {
    id: 'a',
    question: '暗色主题?',
    answer: '暗色',
    facts: [{ text: '用户偏好暗色主题' }],
  },
  {
    id: 'b',
    question: '缺失?',
    answer: '不存在',
    facts: [{ text: '别的内容' }],
  },
];

test('score：recall@k / MRR / 逐 case 明细', async () => {
  const report = await LongMemEval.score(
    CASES,
    async (query) => {
      if (query === '暗色主题?') return [{ text: '用户偏好暗色主题' }];
      return [{ text: '别的内容' }];
    },
    5,
  );
  assert.strictEqual(report.cases, 2);
  assert.strictEqual(report.hits, 1);
  assert.strictEqual(report.recallAtK, 0.5);
  assert.strictEqual(report.mrr, 0.5);
  assert.deepStrictEqual(report.results[0]?.rank, 1);
});

test('trustedOnly：过滤 untrusted 后答案不再命中', async () => {
  const report = await LongMemEval.score(
    [CASES[0]!],
    async () => [{ text: '暗色主题来自工具输出', trust: 'untrusted' }],
    5,
    true,
  );
  assert.strictEqual(report.hits, 0);
});
