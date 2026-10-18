/**
 * P3/P1 真实 LaYa 候选排序 A/B（集成；需要项目内 venv + 权重）。
 *
 * 这是**受控小样本**：候选补丁与真实测试标签由夹具定义，不用它宣称生产增益；
 * 只回答「LaYa noul 的排序是否真的比随机/改动体量更有区分力」。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LayaDecisionEngine } from '../../src/adapters/laya/layaDecisionEngine.ts';

/** 夹具候选：只有 value=3 的补丁会通过测试。 */
const CANDIDATES = [
  {
    patch:
      '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;',
    pass: false,
  },
  {
    patch:
      '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 3;',
    pass: true,
  },
  {
    patch:
      '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 4;',
    pass: false,
  },
  {
    patch:
      '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 5;',
    pass: false,
  },
  {
    patch:
      '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 6;',
    pass: false,
  },
  {
    patch:
      '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 7;',
    pass: false,
  },
] as const;

/** Mann-Whitney AUC。 */
function auc(positives: readonly number[], negatives: readonly number[]): number {
  if (positives.length === 0 || negatives.length === 0) return Number.NaN;
  let wins = 0;
  for (const p of positives) {
    for (const n of negatives) {
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

test.skipIf(!existsSync(join(process.cwd(), 'third-party', 'laya-venv')))(
  'LaYa 候选排序 A/B：真实模型 noul 对候选补丁的区分力（小样本受控）',
  async () => {
    const engine = new LayaDecisionEngine();
    try {
      assert.strictEqual(await engine.isAvailable(), true, '项目内 Laya 应可用');
      await engine.warmUp(300_000);
      const predictions: number[] = [];
      for (const candidate of CANDIDATES) {
        const response = await engine.decide({
          state: candidate.patch,
          questions: {
            passTest: { kind: 'noul', instructions: '这份候选补丁会跑通既有测试吗？' },
          },
        });
        assert.strictEqual(response.available, true, response.note);
        const noul = response.answers['passTest']?.noul;
        if (typeof noul !== 'number') throw new Error('Laya 未返回数值 noul');
        predictions.push(noul);
      }
      const positives = predictions.filter((_p, index) => CANDIDATES[index]?.pass === true);
      const negatives = predictions.filter((_p, index) => CANDIDATES[index]?.pass !== true);
      const score = auc(positives, negatives);
      const ranking = predictions
        .map((p, index) => ({ index, p }))
        .sort((a, b) => b.p - a.p)
        .map((item) => item.index);
      // 只断言“仪器真的产出可比较的数字与排序”，不把 6 条夹具当生产增益。
      assert.ok(predictions.every((p) => Number.isFinite(p) && p >= 0 && p <= 1));
      assert.strictEqual(ranking.length, CANDIDATES.length);
      console.log(
        `[LaYa 候选 A/B] n=${String(predictions.length)} AUC=${Number.isNaN(score) ? 'NA' : score.toFixed(3)} ` +
          `top1=#${String(ranking[0])}（期望通过者 #1）；p=${predictions.map((p) => p.toFixed(3)).join(',')}`,
      );
    } finally {
      engine.dispose();
    }
  },
);
