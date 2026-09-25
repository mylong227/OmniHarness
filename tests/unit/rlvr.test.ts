import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../../src/ports/runtime/evolution.js';
import type { Skill } from '../../src/skill/skill.js';
import { VerifiableReward } from '../../src/evolution/verifiableReward.js';
import {
  RlvrLoop,
  InMemoryReplayBuffer,
  type CodeCandidate,
  type RlvrSampler,
} from '../../src/evolution/rlvrLoop.js';

function stubCandidate(source: string, meta: Record<string, unknown> = {}): Candidate {
  const skill = { name: `s-${source}`, description: 'stub' } as unknown as Skill;
  return { skill, source, meta };
}

test('verifiableRewardFromCommand: 退出 0 → 1，退出非 0 → 0', async () => {
  const reward = VerifiableReward.verifiableRewardFromCommand(
    (c) => c.meta?.cmd as string | undefined,
  );
  const green = await reward(stubCandidate('a', { cmd: 'node -e "process.exit(0)"' }));
  const red = await reward(stubCandidate('b', { cmd: 'node -e "process.exit(1)"' }));
  assert.strictEqual(green, 1);
  assert.strictEqual(red, 0);
  // 缺命令 → 0（fail-closed）。
  assert.strictEqual(await reward(stubCandidate('c')), 0);
});

test('createVerifiableGate: 可验证奖励达成 → 晋升', async () => {
  const reward = VerifiableReward.verifiableRewardFromCommand(
    (c) => c.meta?.cmd as string | undefined,
  );
  const gate = VerifiableReward.createVerifiableGate(reward, { minGain: 0.05, baseline: 0 });
  const verdict = await gate.evaluate(stubCandidate('ok', { cmd: 'node -e "process.exit(0)"' }));
  assert.strictEqual(verdict.promoted, true);
  assert.strictEqual(verdict.score, 1);
  const bad = await gate.evaluate(stubCandidate('bad', { cmd: 'node -e "process.exit(1)"' }));
  assert.strictEqual(bad.promoted, false);
});

test('RlvrLoop: 仅绿样本入回放缓冲，best 取最高奖励', async () => {
  const buffer = new InMemoryReplayBuffer();
  // 交替绿/红：代码含 'good' → 奖励 1；否则 0。
  const sampler: RlvrSampler = {
    sample(_prompt: string, i: number): CodeCandidate | undefined {
      if (i >= 6) return undefined;
      return { id: `c${i}`, code: i % 2 === 0 ? 'good' : 'bad' };
    },
  };
  const reward = async (c: CodeCandidate) => (c.code.includes('good') ? 1 : 0);
  const loop = new RlvrLoop({ sampler, reward, buffer, samplesPerPrompt: 6, minReward: 0 });
  const res = await loop.run('fix the bug');
  assert.strictEqual(res.kept, 3, '3 个绿样本入缓冲');
  assert.strictEqual(buffer.size, 3);
  assert.ok(res.best !== undefined);
  assert.strictEqual(res.best!.reward, 1);
  assert.strictEqual(res.best!.candidate.id, 'c0');
});

test('RlvrLoop: 全红样本 → 无任何入缓冲', async () => {
  const buffer = new InMemoryReplayBuffer();
  const sampler: RlvrSampler = {
    sample(_p: string, i: number): CodeCandidate | undefined {
      return i < 4 ? { id: `x${i}`, code: 'bad' } : undefined;
    },
  };
  const reward = async () => 0;
  const loop = new RlvrLoop({ sampler, reward, buffer, samplesPerPrompt: 4 });
  const res = await loop.run('p');
  assert.strictEqual(res.kept, 0);
  assert.strictEqual(buffer.size, 0);
  assert.strictEqual(res.best, undefined);
});

test('RlvrLoop: 回放缓冲 FIFO 容量上限', async () => {
  const buffer = new InMemoryReplayBuffer(2);
  const sampler: RlvrSampler = {
    sample(_p: string, i: number): CodeCandidate | undefined {
      return { id: `y${i}`, code: 'good' };
    },
  };
  const reward = async () => 1;
  const loop = new RlvrLoop({ sampler, reward, buffer, samplesPerPrompt: 5 });
  await loop.run('p');
  assert.strictEqual(buffer.size, 2, '超出容量按 FIFO 截断');
  assert.strictEqual(buffer.entries[buffer.entries.length - 1]!.candidate.id, 'y4');
});
