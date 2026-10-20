/** 模型结束原因归一化判据（2026-10-21）。 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ModelFinishReasons } from '../../src/util/modelFinishReasons.ts';

test('normalize：各厂商截断字面量统一为 length', () => {
  for (const raw of [
    'length',
    'max_tokens',
    'max_output_tokens',
    'max-tokens',
    'max-output-tokens',
  ]) {
    assert.strictEqual(ModelFinishReasons.normalize(raw), 'length', raw);
  }
});

test('normalize：正常结束统一为 stop，未知值原样保留', () => {
  for (const raw of ['stop', 'end_turn', 'completed']) {
    assert.strictEqual(ModelFinishReasons.normalize(raw), 'stop', raw);
  }
  assert.strictEqual(ModelFinishReasons.normalize('tool_calls'), 'tool_calls');
  assert.strictEqual(ModelFinishReasons.normalize('content_filter'), 'content_filter');
  assert.strictEqual(ModelFinishReasons.normalize(undefined), undefined);
  assert.strictEqual(ModelFinishReasons.normalize(''), undefined);
});

test('isTruncated：对未归一化的第三方适配器也生效', () => {
  assert.strictEqual(ModelFinishReasons.isTruncated('length'), true);
  assert.strictEqual(ModelFinishReasons.isTruncated('max_tokens'), true);
  assert.strictEqual(ModelFinishReasons.isTruncated('MAX_TOKENS'), true);
  assert.strictEqual(ModelFinishReasons.isTruncated('stop'), false);
  assert.strictEqual(ModelFinishReasons.isTruncated(undefined), false);
});
