import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TokenEstimatorCalibrator } from '../../src/context/tokenEstimatorCalibrator.ts';

test('CTX-02：校准报告给出 median/p90 误差与系数', () => {
  const calibrator = new TokenEstimatorCalibrator();
  calibrator.observe({ estimated: 100, actual: 110 });
  calibrator.observe({ estimated: 100, actual: 120 });
  calibrator.observe({ estimated: 100, actual: 130 });
  const report = calibrator.report();
  assert.strictEqual(report.samples, 3);
  assert.ok(report.medianErrorPct > 0);
  assert.ok(report.p90ErrorPct >= report.medianErrorPct);
  assert.ok(report.factor > 1);
});

test('CTX-02：非法样本被忽略，空报告 factor=1', () => {
  const calibrator = new TokenEstimatorCalibrator();
  calibrator.observe({ estimated: 0, actual: 10 });
  calibrator.observe({ estimated: 10, actual: 0 });
  assert.deepStrictEqual(calibrator.report(), {
    samples: 0,
    medianErrorPct: 0,
    p90ErrorPct: 0,
    factor: 1,
  });
});
