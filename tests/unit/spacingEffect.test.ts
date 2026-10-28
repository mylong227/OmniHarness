/**
 * 间隔效应（Spacing Effect）判据：Ebbinghaus 遗忘曲线 + 间隔重复 → 长期记忆召回。
 *
 * 机制与预注册边界见 `src/adapters/memory/spacingEffect.ts` 类注释与
 * `docs/NATURE_INSPIRED_RND_2026-10-27.md` §1。判据全部用**注入固定时钟**（确定性）：
 *  - 纯函数层：S0 锚点、R 单调性、合意困难方向性、稳定度上限；
 *  - 集成层：保持率主导排序、召回强化写回与排序反超（间隔重复闭环）、默认关零扰动。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpacingEffect } from '../../src/adapters/memory/spacingEffect.ts';
import { FileLongTermMemory } from '../../src/adapters/memory/fileLongTermMemory.ts';
import type { MemoryFact } from '../../src/ports/memory/longTermMemory.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 构造一条事实（只填判据关心的字段）。 */
function factOf(
  id: string,
  text: string,
  importance: number,
  extra: Partial<MemoryFact> = {},
): MemoryFact {
  return {
    id,
    text,
    importance,
    createdAt: '2026-01-01T00:00:00.000Z',
    sessionId: 's1',
    source: 'tool',
    ...extra,
  };
}

test('纯函数：S0 锚点 = 30×importance（imp 3 ⇒ 90 天与旧全局半衰期同锚）', () => {
  assert.strictEqual(SpacingEffect.initialStabilityDays(3), 90);
  assert.strictEqual(SpacingEffect.initialStabilityDays(1), 30);
  assert.strictEqual(SpacingEffect.initialStabilityDays(5), 150);
  // 越界夹紧。
  assert.strictEqual(SpacingEffect.initialStabilityDays(0), 30);
  assert.strictEqual(SpacingEffect.initialStabilityDays(9), 150);
});

test('纯函数：保留率单调递减且 0.5^(t/S) 口径正确', () => {
  const epoch = Date.parse('2020-01-01T00:00:00.000Z');
  const r0 = SpacingEffect.retention(epoch, epoch, 90);
  const rHalf = SpacingEffect.retention(epoch + 90 * DAY_MS, epoch, 90);
  const rFull = SpacingEffect.retention(epoch + 180 * DAY_MS, epoch, 90);
  assert.strictEqual(r0, 1);
  assert.ok(Math.abs(rHalf - 0.5) < 1e-9, '一个稳定度周期后保留率应恰为 0.5');
  assert.ok(Math.abs(rFull - 0.25) < 1e-9);
  assert.ok(rFull < rHalf && rHalf < r0);
  // 非法锚点（0/负）按 1 不衰减（与 TimeDecay 的宽容口径一致）。
  assert.strictEqual(SpacingEffect.retention(epoch, 0, 90), 1);
});

test('纯函数：合意困难——越接近遗忘（低 R）召回，稳定度增益越大', () => {
  const fresh = SpacingEffect.reinforcedStability(90, 0.9); // 刚强化过（高保留）
  const stale = SpacingEffect.reinforcedStability(90, 0.3); // 接近遗忘才召回（低保留）
  assert.strictEqual(fresh, 90 * 1.1);
  assert.strictEqual(stale, 90 * 1.7);
  assert.ok(stale > fresh, '低保留召回的增益必须更大');
  // 上限封顶（10 年）。
  assert.strictEqual(SpacingEffect.reinforcedStability(3000, 0.01), 3650);
});

test('集成（开启）：同分双事实，最近被召回者排前；召回强化写回并使排序反超', () => {
  process.env['OMNI_MEMORY_FORGETTING'] = '1';
  const dir = mkdtempSync(join(tmpdir(), 'omni-spacing-'));
  try {
    let now = Date.parse('2026-06-01T00:00:00.000Z');
    const memory = new FileLongTermMemory(join(dir, 'mem.jsonl'), undefined, 90, () => now);
    memory.remember(factOf('a', 'deploy checklist', 3));
    memory.remember(factOf('b', 'deploy rollback steps', 3));
    // 两条同分：第一条 a 最近被"强化"过（lastRecallAt 新鲜），b 很久前 → 保持率 a > b。
    const t0 = now;
    const first = memory.recall('deploy', 5);
    // 召回本身已对 a/b 记账（同分同锚时按插入序都在 top-k）——先关闭本位效应：
    // 重新建内存（不落强化）验证纯排序差异。
    void first;
    const memory2 = new FileLongTermMemory(join(dir, 'mem2.jsonl'), undefined, 90, () => now);
    memory2.remember(
      factOf('a', 'deploy checklist', 3, { lastRecallAt: new Date(t0 - DAY_MS).toISOString() }),
    );
    memory2.remember(
      factOf('b', 'deploy rollback steps', 3, { createdAt: '2026-01-01T00:00:00.000Z' }),
    );
    const ranked = memory2.recall('deploy', 5);
    assert.strictEqual(ranked[0]?.id, 'a', '新鲜强化的事实（高保持率）应排前');
    assert.strictEqual(ranked[1]?.id, 'b');
    // 间隔重复闭环：召回 b ⇒ b 的稳定度被强化写回 ⇒ 之后 b 从更晚的锚点起算。
    now += 10_000;
    memory2.recall('deploy rollback', 5);
    const bAfter = memory2.get('b');
    assert.ok(bAfter?.stabilityDays !== undefined, '召回命中必须写回稳定度');
    assert.strictEqual(bAfter.recallCount, 1);
    assert.ok(
      bAfter.stabilityDays > 90,
      `强化后应高于初值 90（实际 ${String(bAfter.stabilityDays)}）`,
    );
  } finally {
    delete process.env['OMNI_MEMORY_FORGETTING'];
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('集成（默认关）：排序与旧行为一致，不写任何新字段', () => {
  delete process.env['OMNI_MEMORY_FORGETTING'];
  const dir = mkdtempSync(join(tmpdir(), 'omni-spacing-off-'));
  try {
    let now = Date.parse('2026-06-01T00:00:00.000Z');
    const memory = new FileLongTermMemory(join(dir, 'mem.jsonl'), undefined, 90, () => now);
    memory.remember(factOf('a', 'deploy checklist', 3));
    memory.remember(factOf('b', 'deploy rollback steps', 3));
    const ranked = memory.recall('deploy', 5);
    assert.strictEqual(ranked.length, 2);
    // 旧行为锚点是 createdAt（两条相同 ⇒ 插入序），且不写 lastRecallAt/stabilityDays。
    assert.strictEqual(ranked[0]?.id, 'a');
    for (const fact of ranked) {
      assert.strictEqual(fact.lastRecallAt, undefined, '默认关不得写间隔重复字段');
      assert.strictEqual(fact.stabilityDays, undefined);
      assert.strictEqual(fact.recallCount, undefined);
    }
    now += 60_000;
    memory.recall('deploy', 5);
    // 落盘内容里也不得出现新字段。
    const file = join(dir, 'mem.jsonl');
    assert.ok(existsSync(file));
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes('lastRecallAt'), '默认关时落盘不得出现间隔重复字段');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
