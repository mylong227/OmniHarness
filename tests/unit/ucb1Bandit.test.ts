/**
 * UCB1 判据：冷启动探索、利用高奖励臂、失败臂降权但保留探索界。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Ucb1Bandit } from '../../src/util/concurrency/ucb1Bandit.ts';

test('① 冷启动：每个臂先各选一次', () => {
  const bandit = new Ucb1Bandit(3);
  const picks: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const arm = bandit.select();
    picks.push(arm);
    bandit.record(arm, 0.5);
  }
  assert.deepStrictEqual(picks, [0, 1, 2]);
  assert.strictEqual(bandit.totalPulls(), 3);
});

test('② 利用：奖励高的臂在后续被更多选择', () => {
  const bandit = new Ucb1Bandit(2);
  for (let i = 0; i < 50; i += 1) {
    const arm = bandit.select();
    bandit.record(arm, arm === 0 ? 1 : 0);
  }
  assert.ok(bandit.statsOf(0).pulls > bandit.statsOf(1).pulls, '高奖励臂应被更频繁选择');
  assert.ok(bandit.statsOf(0).mean > 0.8);
});

test('③ 失败臂不会被永久放弃：上界项仍会探测', () => {
  const bandit = new Ucb1Bandit(2);
  for (let i = 0; i < 100; i += 1) {
    const arm = bandit.select();
    bandit.record(arm, arm === 0 ? 1 : 0);
  }
  assert.ok(bandit.statsOf(1).pulls >= 1, '失败臂至少被探索过');
});

test('④ 奖励夹取与非法输入', () => {
  const bandit = new Ucb1Bandit(1);
  bandit.record(0, 5);
  bandit.record(0, -5);
  bandit.record(0, Number.NaN);
  assert.strictEqual(bandit.statsOf(0).rewardSum, 1);
  assert.throws(() => bandit.record(2, 1), RangeError);
  assert.throws(() => new Ucb1Bandit(0), /armCount/);
});
