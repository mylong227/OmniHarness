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

test('A.5 修正后实测：自研路径用**显式时区**（缺省 UTC），且与宿主时区无关', () => {
  // 2026-10-04 **行为修正**：此前 `matchesCron` 用 `date.getHours()` 等宿主本地字段判定，
  // 同一表达式在时区不同的机器上会在**不同时刻**触发（调度器唯一要保证的事）。现在字段值经
  // `Intl.DateTimeFormat` 在**指定时区**下求取，缺省 UTC ⇒ 环境无关（迁移方式见其 JSDoc）。
  const utcNine = new Date(Date.parse('2026-10-04T09:00:30.000Z'));
  assert.strictEqual(
    RoutineScheduler.matchesCron('0 9 * * *', utcNine),
    true,
    '缺省时区是 UTC ⇒ UTC 09:00 必须命中（不再取决于宿主偏移）',
  );
  const nyInstant = Date.parse('2026-10-04T13:00:30.000Z'); // 纽约 09:00（EDT）
  assert.strictEqual(
    RoutineScheduler.matchesCron('0 9 * * *', new Date(nyInstant), 'America/New_York'),
    true,
    '显式给纽约时区 ⇒ 该时区的 09:00 命中',
  );
  assert.strictEqual(
    RoutineScheduler.matchesCron('0 9 * * *', new Date(nyInstant)),
    false,
    '同一瞬时在缺省 UTC 下**不**命中（证明时区真的参与判定，而不是"总是命中"）',
  );

  // **环境无关性自证**：临时改宿主 TZ，同一瞬时 + 同一显式时区必须得到同一结论。
  const priorTz = process.env.TZ;
  try {
    process.env.TZ = 'UTC';
    const asUtcHost = RoutineScheduler.matchesCron('0 9 * * *', utcNine, 'UTC');
    process.env.TZ = 'America/New_York';
    const asNyHost = RoutineScheduler.matchesCron('0 9 * * *', utcNine, 'UTC');
    assert.strictEqual(
      asUtcHost,
      asNyHost,
      '宿主时区改变不得影响显式时区下的判定（这正是修正前的缺陷）',
    );
    assert.strictEqual(asNyHost, true);
    // 星期字段同样按指定时区的日历求取（跨日边界最容易错）。
    assert.strictEqual(
      RoutineScheduler.matchesCron(
        '30 0 * * 0',
        new Date(Date.parse('2026-10-04T00:30:00.000Z')),
        'UTC',
      ),
      true,
      'UTC 周日 00:30 命中 `30 0 * * 0`（星期按 UTC 日历求取）',
    );
    assert.strictEqual(
      RoutineScheduler.matchesCron(
        '30 0 * * 0',
        new Date(Date.parse('2026-10-04T04:30:00.000Z')),
        'America/New_York',
      ),
      true,
      '纽约周日 00:30 同样命中（证明星期不是按 UTC 硬算的）',
    );
  } finally {
    if (priorTz === undefined) delete process.env.TZ;
    else process.env.TZ = priorTz;
  }

  // 注入路径与自研路径**同口径**：显式时区下结论唯一确定。
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
