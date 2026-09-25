import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoutineScheduler } from '../../src/daemon/routineScheduler.js';
import type { Routine } from '../../src/daemon/routineScheduler.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oh-routines-'));
  return join(dir, 'routines.json');
}

function routine(over: Partial<Routine> = {}): Routine {
  return {
    name: 'r1',
    prompt: 'hi',
    modelAdapter: 'mock',
    schedule: { kind: 'interval', minutes: 10 },
    ...over,
  };
}

test('matchesCron：解析 * / 范围 / 列表 / 步长', () => {
  // 每 5 分钟：0,5,10,... 命中
  assert.strictEqual(
    RoutineScheduler.matchesCron('*/5 * * * *', new Date(2026, 0, 1, 10, 0)),
    true,
  );
  assert.strictEqual(
    RoutineScheduler.matchesCron('*/5 * * * *', new Date(2026, 0, 1, 10, 3)),
    false,
  );
  // 指定分/时/日；周与日取并集（此处日命中）
  assert.strictEqual(RoutineScheduler.matchesCron('0 9 1 * *', new Date(2026, 0, 1, 9, 0)), true);
  // 列表
  assert.strictEqual(
    RoutineScheduler.matchesCron('0,30 * * * *', new Date(2026, 0, 1, 9, 30)),
    true,
  );
  // 范围
  assert.strictEqual(RoutineScheduler.matchesCron('1-3 * * * *', new Date(2026, 0, 1, 9, 2)), true);
  assert.strictEqual(
    RoutineScheduler.matchesCron('1-3 * * * *', new Date(2026, 0, 1, 9, 4)),
    false,
  );
});

test('RoutineScheduler：interval 到期判定与 lastRun 防重复', () => {
  const store = tmpStore();
  const scheduler = new RoutineScheduler(store);
  const now = Date.now();
  scheduler.add(routine({ schedule: { kind: 'interval', minutes: 10 } }));
  // 从未运行 → 到期
  assert.strictEqual(scheduler.runDue(now).length, 1);
  scheduler.markRun('r1', now);
  // 刚跑过（<1 分钟）→ 不重复
  assert.strictEqual(scheduler.runDue(now).length, 0);
  // 11 分钟后 → 到期
  assert.strictEqual(scheduler.runDue(now + 11 * 60_000).length, 1);
  rmSync(store, { recursive: true, force: true });
});

test('RoutineScheduler：cron 命中且距上次≥1 分钟才触发', () => {
  const store = tmpStore();
  const scheduler = new RoutineScheduler(store);
  const at = new Date(2026, 0, 1, 10, 0, 0); // 命中 */5
  scheduler.add(routine({ schedule: { kind: 'cron', expr: '*/5 * * * *' } }));
  assert.strictEqual(scheduler.runDue(at.getTime()).length, 1);
  scheduler.markRun('r1', at.getTime());
  // 同分钟（相差 10 秒）→ 不重复
  assert.strictEqual(scheduler.runDue(at.getTime() + 10_000).length, 0);
  // 下一命中分钟（5 分钟后）→ 触发
  const next = new Date(2026, 0, 1, 10, 5, 0);
  assert.strictEqual(scheduler.runDue(next.getTime()).length, 1);
  rmSync(store, { recursive: true, force: true });
});

test('RoutineScheduler：持久化 add/list/remove 幂等', () => {
  const store = tmpStore();
  const scheduler = new RoutineScheduler(store);
  scheduler.add(routine({ name: 'a', prompt: 'p' }));
  scheduler.add(routine({ name: 'a', prompt: 'q' })); // 同名覆盖，lastRun 保留
  scheduler.add(routine({ name: 'b', prompt: 'p2' }));
  assert.strictEqual(scheduler.list().length, 2);
  assert.strictEqual(scheduler.list().find((r) => r.name === 'a')?.prompt, 'q');
  assert.strictEqual(scheduler.remove('b'), true);
  assert.strictEqual(scheduler.remove('b'), false);
  assert.strictEqual(scheduler.list().length, 1);
  rmSync(store, { recursive: true, force: true });
});
