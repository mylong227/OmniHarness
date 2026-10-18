import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ProcessRewardDataset } from '../../src/evolution/processRewardDataset.ts';
import { LogisticProcessReward } from '../../src/evolution/logisticProcessReward.ts';
import type { StepRewardSample } from '../../src/ports/memory/processReward.ts';

/** 造一条样本。 */
function sample(index: number, noul: number, passed: boolean, session: string): StepRewardSample {
  return {
    sessionId: session,
    toolName: 'write_file',
    targets: [`f${String(index % 5)}.ts`],
    noul,
    passed,
    exitCode: passed ? 0 : 1,
    at: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
  };
}

/** 造 80 条、按会话可分的数据。 */
function dataset(): StepRewardSample[] {
  const out: StepRewardSample[] = [];
  for (let index = 0; index < 80; index += 1) {
    const noul = (index % 10) / 10;
    out.push(sample(index, noul, noul >= 0.5, `s${String(Math.floor(index / 4))}`));
  }
  return out;
}

test('PRM 数据集：只保留有 noul 样本，按会话切分且无泄漏', () => {
  const split = ProcessRewardDataset.split(dataset(), { seed: 3 });
  assert.ok(split.train.length > 0);
  assert.ok(split.val.length + split.test.length > 0);
  const sets = [split.train, split.val, split.test].map(
    (part) => new Set(part.map((entry) => entry.sessionId)),
  );
  for (let left = 0; left < sets.length; left += 1) {
    for (let right = left + 1; right < sets.length; right += 1) {
      for (const id of sets[left] ?? []) {
        assert.ok(!(sets[right] ?? new Set()).has(id), `会话 ${String(id)} 跨切分泄漏`);
      }
    }
  }
  const withoutNoul = ProcessRewardDataset.split([
    { ...sample(1, 0.5, true, 's'), noul: undefined },
  ]);
  assert.strictEqual(
    withoutNoul.train.length + withoutNoul.val.length + withoutNoul.test.length,
    0,
  );
});

test('PRM 基线：可训练、可评测、可序列化（测试集 AUC 应有区分力）', () => {
  const split = ProcessRewardDataset.split(dataset(), { seed: 7 });
  const model = LogisticProcessReward.train(split.train, split.val);
  const metrics = model.evaluate(split.test);
  assert.ok(metrics.samples > 0);
  assert.ok(metrics.auc > 0.8, `AUC 应 >0.8，实际 ${String(metrics.auc)}`);
  assert.ok(metrics.brier < 0.25);
  const restored = LogisticProcessReward.fromJson(model.toJson());
  const sampleHigh = sample(1, 0.9, true, 'sx');
  const sampleLow = sample(2, 0.1, false, 'sy');
  assert.ok(restored.predict(sampleHigh) > restored.predict(sampleLow));
});

test('PRM 基线：样本不足/单一类别 fail-closed', () => {
  assert.throws(() => LogisticProcessReward.train([], []), /样本不足/u);
  const onlyPass = Array.from({ length: 12 }, (_v, index) =>
    sample(index, 0.8, true, `s${String(index)}`),
  );
  assert.throws(() => LogisticProcessReward.train(onlyPass, []), /同时包含/u);
});
