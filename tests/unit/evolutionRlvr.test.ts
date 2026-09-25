import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionControllerImpl } from '../../src/evolution/evolutionControllerImpl.js';
import { FailClosedEvolutionGate } from '../../src/evolution/failClosedEvolutionGate.js';
import { RlvrLoop, InMemoryReplayBuffer } from '../../src/evolution/rlvrLoop.js';
import type { CodeCandidate } from '../../src/evolution/rlvrLoop.js';
import { RlvrController } from '../../src/evolution/rlvrController.js';
import type { Candidate } from '../../src/ports/runtime/evolution.js';
import type { Skill } from '../../src/skill/skill.js';
import type { ModelPort } from '../../src/ports/model/model.js';

const skill: Skill = { name: 's', description: 'd', instructions: 'do it' };
const candidate: Candidate = { skill, source: 'twist:a+b' };

/** 恒晋升门禁（基准满分、增益 0）。 */
function alwaysPromoteGate(): FailClosedEvolutionGate {
  return new FailClosedEvolutionGate({ benchmark: () => 1, minGain: 0 });
}

/** 构造一个固定 3 样本的 RLVR 循环，奖励由外部控制。 */
function makeLoop(reward: (c: CodeCandidate) => number | Promise<number>): RlvrLoop {
  const sampler = {
    sample(_p: string, i: number): CodeCandidate | undefined {
      if (i >= 3) return undefined;
      return { id: `c${i}`, code: `x${i}` };
    },
  };
  const buffer = new InMemoryReplayBuffer();
  return new RlvrLoop({ sampler, reward: async (c) => reward(c), buffer, samplesPerPrompt: 3 });
}

const oneCandidateDiscovery = {
  nextCandidates: () => [candidate],
  budgetUsed: () => ({ generated: 1, maxCandidates: 1 }),
};

test('U4 RLVR 阶段：过门禁 + 有绿样本 → 晋升', async () => {
  const ctrl = new EvolutionControllerImpl({
    discovery: oneCandidateDiscovery,
    gate: alwaysPromoteGate(),
    rlvr: { loop: makeLoop(() => 1), promptFor: () => 'implement s' },
  });
  const v = await ctrl.cycle();
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0]!.promoted, true);
});

test('U4 RLVR 阶段：过门禁 + 无绿样本 → RLVR 否决晋升', async () => {
  const ctrl = new EvolutionControllerImpl({
    discovery: oneCandidateDiscovery,
    gate: alwaysPromoteGate(),
    rlvr: { loop: makeLoop(() => 0), promptFor: () => 'implement s' },
  });
  const v = await ctrl.cycle();
  assert.strictEqual(v[0]!.promoted, false);
  assert.match(v[0]!.reason, /RLVR/);
});

test('U4 RLVR 阶段：promptFor 返回 undefined → 跳过 RLVR，按门禁晋升', async () => {
  // 即便 RLVR 无绿样本，跳过阶段也应直接晋升。
  const ctrl = new EvolutionControllerImpl({
    discovery: oneCandidateDiscovery,
    gate: alwaysPromoteGate(),
    rlvr: { loop: makeLoop(() => 0), promptFor: () => undefined },
  });
  const v = await ctrl.cycle();
  assert.strictEqual(v[0]!.promoted, true);
});

test('U4 组合器：无 verifyCommand → RLVR 奖励恒 0 → 不晋升且回放缓冲为空', async () => {
  const mockModel = {
    generate: async () => ({ text: '```ts\nconst a = 1;\n```' }),
  } as unknown as ModelPort;
  const a: Skill = { name: 'a', description: 'da', instructions: 'ia' };
  const b: Skill = { name: 'b', description: 'db', instructions: 'ib' };
  const { controller, buffer } = RlvrController.createRlvrEvolutionController({
    skills: [a, b],
    compose: (x) => ({ ...x, name: 'composed' }),
    model: mockModel,
    gateBenchmark: () => 1,
    autoRun: false,
  });
  const v = await controller.cycle();
  // 发现引擎应产出 1 个组合候选，门禁满分但通过；RLVR 无验证命令→奖励 0→被否决。
  assert.ok(v.length >= 1);
  assert.strictEqual(v[0]!.promoted, false);
  assert.strictEqual(buffer.size, 0);
});
