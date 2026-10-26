/**
 * Metrics 分位数：GK 草图接入回合耗时，Prometheus 暴露 p50/p95/p99。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Metrics } from '../../src/server/services/metrics.ts';

test('指标：回合耗时 p50/p95/p99 可见且边界正确', () => {
  const metrics = new Metrics();
  for (let i = 1; i <= 1000; i += 1) metrics.recordTurn(i);
  const turns = metrics.snapshot().turns;
  assert.strictEqual(turns.count, 1000);
  assert.ok(Math.abs(turns.p50Ms - 500) <= 20, `p50=${turns.p50Ms}`);
  assert.ok(Math.abs(turns.p95Ms - 950) <= 20, `p95=${turns.p95Ms}`);
  assert.ok(Math.abs(turns.p99Ms - 990) <= 20, `p99=${turns.p99Ms}`);
  const prom = metrics.toPrometheus();
  assert.match(prom, /omni_turn_duration_quantile_seconds\{quantile="0\.95"\}/u);
});

test('指标：无回合样本时分位数为 0，不输出 NaN', () => {
  const snapshot = new Metrics().snapshot();
  assert.strictEqual(snapshot.turns.p50Ms, 0);
  assert.strictEqual(snapshot.turns.p95Ms, 0);
  assert.strictEqual(snapshot.turns.p99Ms, 0);
  assert.doesNotMatch(new Metrics().toPrometheus(), /NaN/u);
});
