// 时长格式化契约：小时 / 分钟 / 秒，不再出现「75分3秒」或一直累加的纯秒数。
import assert from 'node:assert/strict';
import { test } from 'vitest';

const { formatDuration, formatDurationMs } = await import('../src/ui/models/DurationFormat.ts');

test('秒级：不足 1 分钟只显示秒', () => {
  assert.strictEqual(formatDuration(0), '0秒');
  assert.strictEqual(formatDuration(59), '59秒');
});

test('分钟级：分钟 + 秒（秒为 0 也保留）', () => {
  assert.strictEqual(formatDuration(60), '1分0秒');
  assert.strictEqual(formatDuration(61), '1分1秒');
  assert.strictEqual(formatDuration(3599), '59分59秒');
});

test('小时级：小时 + 分钟 + 秒三段，不再累加成分钟/秒', () => {
  assert.strictEqual(formatDuration(3600), '1小时0分0秒');
  assert.strictEqual(formatDuration(3661), '1小时1分1秒');
  assert.strictEqual(formatDuration(7325), '2小时2分5秒');
});

test('非法输入按 0 秒处理', () => {
  assert.strictEqual(formatDuration(-5), '0秒');
  assert.strictEqual(formatDuration(Number.NaN), '0秒');
  assert.strictEqual(formatDuration(Number.POSITIVE_INFINITY), '0秒');
});

test('毫秒入口四舍五入到整秒', () => {
  assert.strictEqual(formatDurationMs(1_500), '2秒');
  assert.strictEqual(formatDurationMs(65_000), '1分5秒');
  assert.strictEqual(formatDurationMs(3_661_000), '1小时1分1秒');
});
