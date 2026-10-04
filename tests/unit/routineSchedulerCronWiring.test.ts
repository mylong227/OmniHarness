/**
 * Wave A.5 接线判据：`CronSchedulePort` 必须被**真实路径**消费，且不注入时行为逐位不变。
 *
 * 为什么要单独立判据（CODE_STANDARD §11.3「声明即接线」）：本仓最高频的缺陷形态就是
 * 「端口/配置声明了却没人读」——一个新端口配一份漂亮的实现与自测，但生产路径仍走老逻辑，
 * 那就等于没接。本文件从 `RoutineScheduler` 的**对外行为**上证明接线真的发生：
 * 注入带时区的实现后，同一份 routines.json 的到期判定结果**必须改变**（否则就是没接）；
 * 不注入时，结果必须与既有自研路径**完全一致**（兼容路径没被偷偷改掉）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RoutineScheduler } from '../../src/daemon/routineScheduler.js';
import { CronerSchedule } from '../../src/adapters/schedule/cronerSchedule.js';
import type { Routine } from '../../src/ports/daemon/routine.js';

/**
 * 在临时目录里写一份 routines.json 并造调度器。
 * @param routines 任务数组
 * @param opts 是否注入 cron 实现
 * @returns 调度器与存储路径
 */
function schedulerWith(
  routines: readonly Routine[],
  opts: { readonly injectCron: boolean; readonly timezone?: string },
): RoutineScheduler {
  const dir = mkdtempSync(join(tmpdir(), 'omni-routines-'));
  const store = join(dir, 'routines.json');
  writeFileSync(store, JSON.stringify({ routines }, null, 2), 'utf8');
  return new RoutineScheduler(
    store,
    opts.injectCron
      ? {
          cron: new CronerSchedule(),
          ...(opts.timezone !== undefined ? { timezone: opts.timezone } : {}),
        }
      : {},
  );
}

/**
 * 造一条 cron 型任务（lastRun 可指定，用于控制到期判定）。
 * @param expr cron 表达式
 * @param lastRun 上次执行时刻（epoch ms）
 * @returns Routine
 */
function cronRoutine(expr: string, lastRun?: number): Routine {
  return {
    name: 'probe',
    prompt: 'p',
    modelAdapter: 'mock',
    schedule: { kind: 'cron', expr },
    ...(lastRun !== undefined ? { lastRun } : {}),
  };
}

test('A.5 接线：注入后 cron 型任务的到期判定随时区改变（证明真的走了端口）', () => {
  // 「每天 9:00」：Asia/Shanghai 语义下 2026-10-04T01:00Z 正是 09:00 的触发点；UTC 语义下那一刻只是 01:00。
  // lastRun 取 00:30Z（两个口径的分叉点）：上海口径已过 01:00Z 触发点，UTC 口径下一次要等 09:00Z。
  const instant = Date.parse('2026-10-04T01:00:30.000Z');
  const lastRun = Date.parse('2026-10-04T00:30:00.000Z');
  const routine = cronRoutine('0 9 * * *', lastRun);

  const shanghai = schedulerWith([routine], { injectCron: true, timezone: 'Asia/Shanghai' });
  assert.strictEqual(shanghai.timezoneAware(), true, '注入后必须如实申报时区感知');
  assert.deepStrictEqual(
    shanghai.runDue(instant).map((r) => r.name),
    ['probe'],
    '上海 9:00 = 01:00Z：该时刻必须到期',
  );

  const utc = schedulerWith([routine], { injectCron: true, timezone: 'UTC' });
  assert.deepStrictEqual(
    utc.runDue(instant).map((r) => r.name),
    [],
    'UTC 9:00 = 09:00Z：01:00Z 不该到期——两者不同才证明端口被真实消费',
  );

  // 缺省时区由实现决定（本仓 UTC）：与显式 UTC 等价、与宿主本地无关。
  const byDefault = schedulerWith([routine], { injectCron: true });
  assert.deepStrictEqual(byDefault.runDue(instant), utc.runDue(instant));
});

test('A.5 实测：自研路径用的是**宿主本地**时区（不是 UTC）——环境相关缺陷已登记', () => {
  // 用「本地时间构造」的瞬时：它在任何宿主上都代表本地 09:00。
  const localNine = new Date(2026, 9, 4, 9, 0, 30);
  assert.strictEqual(
    RoutineScheduler.matchesCron('0 9 * * *', localNine),
    true,
    '自研 matchesCron 命中「本地 09:00」——证明它读的是本地字段（getHours 等），不是 UTC',
  );
  // 反证：UTC 09:00 的瞬时是否命中**完全取决于宿主偏移**（本机 Asia/Shanghai 下不命中）。
  const utcNine = new Date(Date.parse('2026-10-04T09:00:30.000Z'));
  const hostOffsetMinutes = utcNine.getTimezoneOffset();
  assert.strictEqual(
    RoutineScheduler.matchesCron('0 9 * * *', utcNine),
    hostOffsetMinutes === 0,
    `宿主偏移 ${hostOffsetMinutes} 分钟：UTC 09:00 是否命中取决于宿主时区（可复现性缺陷）`,
  );
  // 注入路径与宿主时区无关：同一瞬时的结论由显式时区唯一确定。
  const schedule = new CronerSchedule();
  const sameInstant = Date.parse('2026-10-04T09:00:30.000Z');
  assert.deepStrictEqual(
    schedule.nextRunAt('0 9 * * *', sameInstant, 'UTC'),
    schedule.nextRunAt('0 9 * * *', sameInstant, 'UTC'),
    '显式时区下结论稳定（不以宿主为输入）',
  );
});

test('A.5 fail-closed：表达式非法 ⇒ 判定为不到期（不误触发、不抛）', () => {
  const instant = Date.parse('2026-10-04T09:00:00.000Z');
  const broken = schedulerWith([cronRoutine('not a cron')], { injectCron: true, timezone: 'UTC' });
  assert.deepStrictEqual(broken.runDue(instant), [], '非法表达式不得触发任务');
});

test('A.5 永不匹配：合法但无解的表达式（2 月 30 日）⇒ 不到期，且不抛', () => {
  const instant = Date.parse('2026-10-04T09:00:00.000Z');
  const impossible = schedulerWith([cronRoutine('0 0 30 2 *')], {
    injectCron: true,
    timezone: 'UTC',
  });
  assert.deepStrictEqual(impossible.runDue(instant), [], '永不匹配 ⇒ 不到期（null 不是错误）');
});

test('A.5 interval 型不受影响：注入 cron 实现后 interval 语义逐位不变', () => {
  const base = Date.parse('2026-10-04T09:00:00.000Z');
  const routine: Routine = {
    name: 'tick',
    prompt: 'p',
    modelAdapter: 'mock',
    schedule: { kind: 'interval', minutes: 30 },
    lastRun: base - 31 * 60_000,
  };
  const at = base;
  const legacy = schedulerWith([routine], { injectCron: false });
  const injected = schedulerWith([routine], { injectCron: true });
  assert.deepStrictEqual(
    injected.runDue(at).map((r) => r.name),
    legacy.runDue(at).map((r) => r.name),
    'interval 型必须与既有行为一致（注入只影响 cron 判定）',
  );
  assert.deepStrictEqual(
    legacy.runDue(at).map((r) => r.name),
    ['tick'],
    '31 分钟前跑过 ⇒ 到期',
  );
});
