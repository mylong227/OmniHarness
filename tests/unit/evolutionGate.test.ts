// 进化门禁（I-P1-4 保形 fail-closed）单元测试。
// 覆盖：A/B 实证（组合技能 > 单技能）、默认拒绝兜底、安全检查阻断、审计哈希链入链、控制器闭环晋升。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Skill } from '../../src/skill/skill.js';
import { composeByTwist } from '../../src/skill/moireComposer.js';
import { jointProfile, capabilityCoverage, moireEnergy } from '../../src/evolution/benchmark.js';
import { FailClosedEvolutionGate } from '../../src/evolution/failClosedEvolutionGate.js';
import type { Benchmark } from '../../src/evolution/failClosedEvolutionGate.js';
import { TwistDiscoveryEngine } from '../../src/evolution/twistDiscoveryEngine.js';
import { EvolutionControllerImpl } from '../../src/evolution/evolutionControllerImpl.js';
import { AuditSink } from '../../src/server/services/auditSink.js';
import type { Candidate } from '../../src/ports/runtime/evolution.js';

const N = 64;

/** 确定性基础技能（文本不同 → 能力场朝向不同，可复现）。 */
function baseSkill(name: string, topic: string): Skill {
  return {
    name,
    description: `${topic} 相关能力`,
    instructions: `执行 ${topic} 任务的具体步骤。`,
    tags: [topic],
  };
}

const A = baseSkill('skill-a', '检索');
const B = baseSkill('skill-b', '推理');

/** 联合任务画像（"需同时具备 A 与 B"，用于针对性覆盖基准）。 */
const PROFILE = jointProfile(A, B, N);

/** 通用涌现能量基准（与文本无关、稳定分离：组合技能自带长波乘积结构 → 高）。 */
const benchmark: Benchmark = (c: Candidate) => moireEnergy(c.skill, N);

/** 单技能涌现能量（用作基线，应显著低于组合技能）。 */
const eA = moireEnergy(A, N);
const eB = moireEnergy(B, N);
const baseline = Math.max(eA, eB);

test('A/B 实证：莫尔组合技能涌现能量 > 任一单技能（市面唯一增益）', () => {
  const composed = composeByTwist(A, B);
  const eComposed = moireEnergy(composed, N);
  // 单技能仅单一频率光栅 → 模糊后均匀衰减；组合技能含低频莫尔项 → 显著更高。
  assert.ok(eComposed > eA, `组合 ${eComposed.toFixed(3)} 应 > A ${eA.toFixed(3)}`);
  assert.ok(eComposed > eB, `组合 ${eComposed.toFixed(3)} 应 > B ${eB.toFixed(3)}`);
  assert.ok(eComposed > 0.3, `组合涌现能量应显著 >0.3，实得 ${eComposed.toFixed(3)}`);
});

test('A/B 实证（针对性）：组合技能对联合画像覆盖 > 单技能', () => {
  const composed = composeByTwist(A, B);
  const covComposed = capabilityCoverage(composed, PROFILE, N);
  const covA = capabilityCoverage(A, PROFILE, N);
  const covB = capabilityCoverage(B, PROFILE, N);
  assert.ok(covComposed > covA, `覆盖 ${covComposed.toFixed(3)} 应 > A ${covA.toFixed(3)}`);
  assert.ok(covComposed > covB, `覆盖 ${covComposed.toFixed(3)} 应 > B ${covB.toFixed(3)}`);
});

test('fail-closed 默认拒绝：未配置真实基准时任何候选都不晋升', async () => {
  const gate = new FailClosedEvolutionGate(); // 无 benchmark
  const composed = composeByTwist(A, B);
  const v = await gate.evaluate({ skill: composed, source: 'twist:a+b' });
  assert.strictEqual(v.promoted, false);
  assert.strictEqual(v.score, 0);
  assert.strictEqual(v.safety, 'pass');
  assert.match(v.reason, /未达晋升阈值|隔离/);
});

test('晋升：组合技能得分超过基线+增益 → 晋升', async () => {
  const gate = new FailClosedEvolutionGate({ benchmark, baseline, minGain: 0.05 });
  const composed = composeByTwist(A, B);
  const v = await gate.evaluate({
    skill: composed,
    source: 'twist:a+b',
    meta: composed.moire as Readonly<Record<string, unknown>> | undefined,
  });
  assert.strictEqual(v.promoted, true);
  assert.ok(
    v.score > baseline + 0.05,
    `score ${v.score.toFixed(3)} 应 > 基线 ${baseline.toFixed(3)} + 0.05`,
  );
  assert.match(v.reason, /晋升/);
});

test('安全检查阻断：safety 返回 false → 不晋升且标记 blocked', async () => {
  const gate = new FailClosedEvolutionGate({
    benchmark,
    baseline,
    safety: () => false, // 任何候选都不安全
  });
  const composed = composeByTwist(A, B);
  const v = await gate.evaluate({ skill: composed, source: 'twist:a+b' });
  assert.strictEqual(v.promoted, false);
  assert.strictEqual(v.safety, 'blocked');
  assert.strictEqual(v.score, 0);
  assert.match(v.reason, /安全检查/);
});

test('审计链：每次裁决写入哈希链，verify ok 且含 evolution 事件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-evo-'));
  const sink = new AuditSink({ dir });
  const gate = new FailClosedEvolutionGate({
    benchmark,
    baseline,
    audit: sink,
    sessionId: 'eval-1',
  });
  const composed = composeByTwist(A, B);
  await gate.evaluate({ skill: composed, source: 'twist:a+b' });
  const report = sink.verify();
  assert.strictEqual(report.ok, true);
  assert.ok(report.count >= 1);
});

test('控制器闭环：发现→评估→晋升，onPromote 被调用且仅晋升达标者', async () => {
  const promoted: string[] = [];
  const discovery = new TwistDiscoveryEngine({
    skills: [A, B],
    compose: (a, b) => composeByTwist(a, b),
    maxCandidates: 4,
  });
  const gate = new FailClosedEvolutionGate({ benchmark, baseline, minGain: 0.05 });
  const controller = new EvolutionControllerImpl({
    discovery,
    gate,
    onPromote: (c) => promoted.push(c.skill.name),
  });
  const verdicts = await controller.cycle();
  assert.strictEqual(verdicts.length, 1);
  assert.strictEqual(verdicts[0]!.promoted, true);
  assert.deepStrictEqual(promoted, ['moire:skill-a+skill-b']);
  assert.strictEqual(controller.budgetUsed().generated, 1);
});
