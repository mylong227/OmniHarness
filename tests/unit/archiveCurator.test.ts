/**
 * 档案管理员判据（GEE Kernel v1 · ② expand 环；S3 期从 Kernel 拆出的独立职责）。
 *
 * 判据口径（三段纪律，顺序即语义）：
 * - **入档 → 复活早前冻结者 → 冻结本轮裁决**：同轮冻结者不得同轮复活
 *   （复活的语义是「给早前负结果第二次机会」，不是无间隔重采样）；
 * - 冻结是**标记**不是删除：退出 `elites()` 精英流、留档待 `reviveFor`；
 * - 复活者排入重入通道；复核次数**按候选计**，超上限即退役停复活
 *   （防「拒绝 ⇄ 复活」永动空转——复核成本是评估预算的一部分）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ArchiveCurator } from '../../src/evolution/archiveCurator.js';
import { BucketedCandidateArchive } from '../../src/evolution/bucketedCandidateArchive.js';
import { EliteReentryDiscovery } from '../../src/evolution/eliteReentryDiscovery.js';
import type { PromotionVerdict } from '../../src/ports/runtime/evolution.js';

/**
 * 造一条被拒裁决（只关心 candidate/source/score）。
 * @param name 技能名
 * @param source 候选来源（决定工况桶键）
 * @param score 得分
 * @returns 未晋升裁决
 */
function rejectedVerdict(name: string, source: string, score: number): PromotionVerdict {
  return {
    candidate: { skill: { name, description: name, instructions: `${name} 步骤` }, source },
    promoted: false,
    score,
    baselineScore: 0,
    safety: 'pass',
    reason: 'stub',
  };
}

test('ArchiveCurator：同轮冻结者不复活 / 同工况复活重入 / 复核超限退役', () => {
  const archive = new BucketedCandidateArchive({ maxPerBucket: 16 });
  const reentry = new EliteReentryDiscovery({
    inner: { nextCandidates: () => [], budgetUsed: () => ({ generated: 0, maxCandidates: 0 }) },
  });
  const curator = new ArchiveCurator({ archive, reentry, maxRecheckAttempts: 1 });

  // R1：两条被拒 → 冻结是标记（退出精英流、留档不删），同轮冻结者不得同轮复活。
  const r1 = curator.update([
    rejectedVerdict('c1', 'twist:a+b', 0.1),
    rejectedVerdict('c2', 'twist:a+c', 0.2),
  ]);
  assert.deepStrictEqual(r1, { archived: 2, revived: 0 }, '同轮冻结者不得同轮复活（顺序纪律）');
  assert.strictEqual(archive.elites('twist').length, 0, '被拒者冻结退出精英流（不删除）');
  assert.strictEqual(curator.pending(), 0, '无复活者 → 重入队列空');

  // R2：同工况桶再出新候选 → R1 冻结者复活并排入重入流（复核计数 1）。
  const r2 = curator.update([rejectedVerdict('c3', 'twist:a+d', 0.3)]);
  assert.strictEqual(r2.revived, 2, '同工况复现 → 早前冻结者复活');
  assert.strictEqual(curator.pending(), 2, '复活者排入重入队列（供下轮候选流吐出）');
  assert.deepStrictEqual(
    archive.elites('twist').map((e) => e.candidate.skill.name),
    ['c2', 'c1'],
    '复活即解冻（c1/c2 回到精英流并按得分降序；c3 本轮被冻结）',
  );

  // R3：复活者再次被拒 → 重新冻结；同轮首见的 c3 是**另一次**复核，不受 c1/c2 计数影响。
  const r3 = curator.update([
    rejectedVerdict('c1', 'twist:a+b', 0.1),
    rejectedVerdict('c2', 'twist:a+c', 0.2),
  ]);
  assert.strictEqual(r3.revived, 1, '复核计数按候选计（c3 首见 → 仍可复活）');

  // R4：c1/c2 复核次数已达上限 1 → 退役停复活（负结果留档但不再空转）。
  const r4 = curator.update([
    rejectedVerdict('c1', 'twist:a+b', 0.1),
    rejectedVerdict('c2', 'twist:a+c', 0.2),
  ]);
  assert.strictEqual(r4.revived, 0, '复核超限 → 退役停复活');
  assert.deepStrictEqual(
    archive.elites('twist').map((e) => e.candidate.skill.name),
    ['c3'],
    '退役者恒留冻结态（c1/c2 不进精英流；只剩 R3 解冻后未被再拒的 c3）',
  );
});
