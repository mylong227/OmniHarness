/**
 * T5.2/T5.3/T4.3 晋升准入单测：把「多样性闸 + 退火接受 + 失败模式挖掘」钉在晋升路径上的行为锁死。
 *
 * 覆盖：① 同指纹副本超配额被多样性闸拒（Echo Trap 防线）；② 冷温度下掠劣解被退火拒；
 * ③ 高温下同一劣解被退火接受（Metropolis 对照）；④ 只做减法（未过门禁者绝不被改写成晋升）；
 * ⑤ 失败记录升格为改进提案；⑥ 多样性塌缩告警 + 失败登记；⑦ 空输入零破坏。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnnealedAcceptance } from '../../src/evolution/annealedAcceptance.js';
import { DiversityGuard } from '../../src/evolution/diversityGuard.js';
import { FailurePatternMiner } from '../../src/evolution/failurePatternMiner.js';
import { PromotionAdmission } from '../../src/evolution/promotionAdmission.js';
import type { Candidate, PromotionVerdict } from '../../src/ports/runtime/evolution.js';
import type { Skill } from '../../src/skill/skill.js';

/**
 * 构造技能（默认同 instructions ⇒ 同指纹 ⇒ 互为 Echo 副本）。
 * @param name 技能名
 * @param instructions 指令文本（决定指纹）
 * @returns 技能
 */
function makeSkill(name: string, instructions = 'do the thing'): Skill {
  return { name, description: `${name} 的说明`, instructions };
}

/**
 * 构造「已过门禁」的裁决。
 * @param name 技能名
 * @param score 基准得分
 * @returns 晋升裁决
 */
function passVerdict(name: string, score: number): PromotionVerdict {
  const candidate: Candidate = { skill: makeSkill(name), source: 'twist:a+b' };
  return {
    candidate,
    promoted: true,
    score,
    baselineScore: 0,
    safety: 'pass',
    reason: `得分 ${score.toFixed(3)} ≥ 基线 0.000 + 增益 0.05 → 晋升`,
  };
}

/**
 * 构造「未过门禁」的裁决。
 * @param name 技能名
 * @returns 未晋升裁决
 */
function failVerdict(name: string): PromotionVerdict {
  const candidate: Candidate = { skill: makeSkill(name), source: 'twist:a+b' };
  return {
    candidate,
    promoted: false,
    score: 0.01,
    baselineScore: 0,
    safety: 'pass',
    reason: '得分 0.010 < 基线 0.000 + 增益 0.05 → 隔离（未达晋升阈值）',
  };
}

test('PromotionAdmission：同指纹副本超配额 → 被多样性闸拒绝（Echo Trap 防线）', () => {
  const admission = new PromotionAdmission({
    guard: new DiversityGuard({ maxDuplicates: 2 }),
  });
  // 三份同指纹、同分（同分不掷硬币 ⇒ 判定确定）。
  const result = admission.admit([
    passVerdict('a', 0.9),
    passVerdict('b', 0.9),
    passVerdict('c', 0.9),
  ]);

  assert.strictEqual(result.promoted.length, 2, '配额 2 ⇒ 只准入两份');
  assert.strictEqual(result.rejections.length, 1);
  assert.strictEqual(result.rejections[0]!.stage, 'diversity');
  const rejected = result.verdicts.filter((v) => !v.promoted);
  assert.strictEqual(rejected.length, 1, '被拒裁决必须被改写为未晋升');
  assert.match(rejected[0]!.reason, /多样性闸否决晋升/);
});

test('PromotionAdmission：冷温度下掠劣解被退火接受拒绝（Δ 大 ⇒ 概率≈0）', () => {
  const admission = new PromotionAdmission({
    acceptance: new AnnealedAcceptance({ seed: 42, initialTemperature: 1e-6, cooling: 1 }),
    guard: new DiversityGuard({ maxDuplicates: 5 }),
  });
  const result = admission.admit([passVerdict('best', 1), passVerdict('worse', 0.5)]);

  assert.strictEqual(result.promoted.length, 1, '仅 incumbent 晋升');
  assert.strictEqual(result.rejections.length, 1);
  assert.strictEqual(result.rejections[0]!.stage, 'annealing');
  const rejected = result.verdicts.find((v) => !v.promoted);
  assert.ok(rejected !== undefined);
  assert.match(rejected!.reason, /退火接受否决晋升/);
});

test('PromotionAdmission：高温下同一劣解被退火接受（Metropolis 对照）', () => {
  const admission = new PromotionAdmission({
    acceptance: new AnnealedAcceptance({ seed: 42, initialTemperature: 1e6, cooling: 1 }),
    guard: new DiversityGuard({ maxDuplicates: 5 }),
  });
  const result = admission.admit([passVerdict('best', 1), passVerdict('worse', 0.5)]);

  assert.strictEqual(result.promoted.length, 2, '温度足够高 ⇒ 劣解被接受（非贪心）');
  assert.strictEqual(result.rejections.length, 0);
});

test('PromotionAdmission：只做减法——未过门禁的裁决绝不被改写成晋升', () => {
  const admission = new PromotionAdmission();
  const result = admission.admit([failVerdict('x'), failVerdict('y')]);

  assert.strictEqual(result.promoted.length, 0);
  assert.strictEqual(result.rejections.length, 0, '准入层不处理未过门禁的裁决');
  assert.ok(result.verdicts.every((v) => !v.promoted));
});

test('PromotionAdmission：失败记录进入挖掘并升格为改进提案（同签名 ≥3 次）', () => {
  const admission = new PromotionAdmission({ miner: new FailurePatternMiner(3) });
  admission.admit([failVerdict('x'), failVerdict('y'), failVerdict('z')]);

  const result = admission.admit([failVerdict('w')]);
  assert.ok(admission.failureCount >= 4, '失败历史跨轮累积');
  assert.ok(result.proposals.length >= 1, '高频签名应升格为提案');
  assert.ok(result.proposals[0]!.occurrences >= 3);
  assert.match(result.proposals[0]!.summary, /gate:below-threshold/);
});

test('PromotionAdmission：准入层剔除同样进失败台账（防再犯原料）', () => {
  const admission = new PromotionAdmission({
    guard: new DiversityGuard({ maxDuplicates: 1 }),
  });
  const result = admission.admit([passVerdict('a', 0.9), passVerdict('b', 0.9)]);

  assert.strictEqual(result.rejections.length, 1);
  assert.strictEqual(admission.failureCount, 1, 'Echo 副本被拒 ⇒ 登记一条失败记录');
});

test('PromotionAdmission：多样性塌缩 → collapsed 告警（去重率低于守卫阈值）', () => {
  const admission = new PromotionAdmission({
    guard: new DiversityGuard({ maxDuplicates: 2, minDistinctRatio: 0.9 }),
  });
  const result = admission.admit([
    passVerdict('a', 0.9),
    passVerdict('b', 0.9),
    passVerdict('c', 0.9),
    passVerdict('d', 0.9),
  ]);

  assert.strictEqual(result.collapsed, true);
  assert.strictEqual(result.distinctRatio, 0.5);
  assert.ok(admission.failureCount >= 3, '两条 Echo 剔除 + 一条塌缩告警');
});

test('PromotionAdmission：空输入零破坏', () => {
  const admission = new PromotionAdmission();
  const result = admission.admit([]);

  assert.deepStrictEqual(result.promoted, []);
  assert.strictEqual(result.rejections.length, 0);
  assert.strictEqual(result.distinctRatio, 1);
  assert.strictEqual(result.proposals.length, 0);
});
