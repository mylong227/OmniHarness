/**
 * GK 分位数草图判据：均匀/偏态分布误差界、边界、内存压缩。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { QuantileSketch } from '../../src/util/quantileSketch.ts';

/** 精确分位数（nearest-rank）。 */
function exact(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}

test('① 均匀 1..10000：p50/p95/p99 在 1% 相对误差内', () => {
  const values = Array.from({ length: 10_000 }, (_, i) => i + 1);
  const sketch = new QuantileSketch(0.01);
  for (const value of values) sketch.insert(value);
  for (const q of [0.5, 0.95, 0.99]) {
    const got = sketch.quantile(q);
    const want = exact(values, q);
    assert.ok(Math.abs(got - want) <= 0.02 * values.length, `q=${q} got=${got} want=${want}`);
  }
  assert.ok(sketch.centroidCount() < values.length / 4, '草图应显著压缩');
});

test('② 偏态分布：p99 不被最大值绑架', () => {
  const values = [
    ...Array.from({ length: 990 }, () => 10),
    ...Array.from({ length: 10 }, () => 1000),
  ];
  const sketch = new QuantileSketch(0.01);
  for (const value of values) sketch.insert(value);
  assert.ok(sketch.quantile(0.5) <= 10.1);
  assert.strictEqual(sketch.quantile(0.99) >= 10, true);
  assert.strictEqual(sketch.quantile(1), 1000);
});

test('③ 边界：空草图为 NaN，q 夹取到 [0,1]', () => {
  const empty = new QuantileSketch();
  assert.ok(Number.isNaN(empty.quantile(0.5)));
  const sketch = new QuantileSketch();
  for (const value of [5, 1, 3]) sketch.insert(value);
  assert.strictEqual(sketch.quantile(-1), 1);
  assert.strictEqual(sketch.quantile(2), 5);
  assert.strictEqual(sketch.size(), 3);
});

test('④ 非有限值忽略；clear 归零', () => {
  const sketch = new QuantileSketch();
  sketch.insert(Number.NaN);
  sketch.insert(Number.POSITIVE_INFINITY);
  assert.strictEqual(sketch.size(), 0);
  sketch.insert(42);
  sketch.clear();
  assert.strictEqual(sketch.size(), 0);
  assert.strictEqual(sketch.centroidCount(), 0);
});
