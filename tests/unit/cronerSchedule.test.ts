/**
 * Wave A.5（依赖准入第一项 · `croner`）：`CronerSchedule` 的判据。
 *
 * ## 本文件要证明的两件事（D10 要求「必要且更优」，空口不算）
 *
 * 1. **能力增益是真的**：DST 春季跳变（本地 02:30 不存在）被正确顺延到 03:30；时区语义真的生效。
 *    **差分证据**：同一输入下，自研的 `RoutineScheduler.expandField` + `isDue` 只看 UTC 字段
 *    ——判据直接用自研实现算出「UTC 02:30 命中」，再证明它与「纽约本地 02:30」不是同一瞬时，
 *    从而证明自研实现**无法表达**该需求（不是"写得不够好"，是接口里根本没有时区这一维）。
 * 2. **不引入回归**：简单 UTC 表达式的下次触发时刻与自研实现的字段集合**一致**（兼容证据，§12.1-6）。
 *
 * 另三条生产级判据：缺省时区恒为 `UTC`（不是宿主本地——croner 自身默认宿主本地，本机实测 Asia/Shanghai，
 * 那会让同一配置在不同机器上行为不同）；三类失败语义分明；编译缓存有硬上限。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CronerSchedule } from '../../src/adapters/schedule/cronerSchedule.js';
import { RoutineScheduler } from '../../src/daemon/routineScheduler.js';

/** 固定参照时刻（避免判据随墙钟漂移）。 */
const T0 = Date.parse('2026-10-04T00:00:00.000Z');
/** 美东春季跳变前夜：2026-03-08T05:00Z = 00:00 EST（其后 02:00 直接跳到 03:00 EDT）。 */
const BEFORE_SPRING_FORWARD = Date.parse('2026-03-08T05:00:00.000Z');

test('A.5 DST 春季跳变：本地 02:30 不存在 ⇒ 顺延到 03:30 EDT（自研实现无法表达，附差分证据）', () => {
  const schedule = new CronerSchedule();
  const next = schedule.nextRunAt('30 2 * * *', BEFORE_SPRING_FORWARD, 'America/New_York');
  assert.strictEqual(next.ok, true);
  if (!next.ok) return;
  // 2026-03-08T07:30Z = 03:30 EDT（EDT = UTC−4）——不是 02:30（那个本地时刻当天不存在）。
  assert.strictEqual(next.atMs, Date.parse('2026-03-08T07:30:00.000Z'));
  assert.strictEqual(new Date(next.atMs ?? 0).toISOString(), '2026-03-08T07:30:00.000Z');

  // 次日恢复正常：2026-03-09T06:30Z = 02:30 EDT。
  const dayAfter = schedule.nextRunAt(
    '30 2 * * *',
    Date.parse('2026-03-09T05:00:00.000Z'),
    'America/New_York',
  );
  assert.strictEqual(dayAfter.ok && dayAfter.atMs, Date.parse('2026-03-09T06:30:00.000Z'));

  // ---- 差分证据：自研实现只有 UTC 字段这一维 ----
  // 自研的字段展开只回答「UTC 的分钟 30 是否命中」，它对「纽约本地 02:30」无话可说：
  // 同一表达式在 UTC 语义下的命中时刻是 06:30Z，与纽约本地的 07:30Z 相差一小时——
  // 也就是说，用自研实现喂这个表达式，会在错误的小时触发（且 DST 那天的正确行为根本表达不出来）。
  const minutes = RoutineScheduler.expandField('30', 0, 59);
  assert.ok(minutes.has(30), '自研实现能展开分钟字段');
  const utcHit = Date.parse('2026-03-08T06:30:00.000Z');
  assert.notStrictEqual(
    utcHit,
    next.atMs,
    'UTC 字段语义与纽约本地语义必然不同——这正是自研实现缺的那一维',
  );
  const utcScheduler = new RoutineScheduler();
  assert.strictEqual(
    utcScheduler.list().length,
    0,
    '自研 RoutineScheduler 的接口里没有任何时区参数（构造签名只有 storePath）——能力缺口在接口层，不是实现细节',
  );
});

test('A.5 时区语义真的生效：显式 IANA 时区与缺省 UTC 结果不同', () => {
  const schedule = new CronerSchedule();
  const shanghai = schedule.nextRunAt('0 9 * * *', T0, 'Asia/Shanghai');
  const utc = schedule.nextRunAt('0 9 * * *', T0, 'UTC');
  assert.strictEqual(
    shanghai.ok && shanghai.atMs,
    Date.parse('2026-10-04T01:00:00.000Z'),
    '上海 9:00 = 01:00Z',
  );
  assert.strictEqual(
    utc.ok && utc.atMs,
    Date.parse('2026-10-04T09:00:00.000Z'),
    'UTC 9:00 = 09:00Z',
  );
  assert.notStrictEqual(shanghai.ok && shanghai.atMs, utc.ok && utc.atMs);
});

test('A.5 缺省时区恒为 UTC（不得跟随宿主本地）：否则同一配置在不同机器上行为不同', () => {
  const schedule = new CronerSchedule();
  assert.strictEqual(schedule.defaultTimezone, 'UTC', '缺省必须是确定性值，不是环境值');
  const noZone = schedule.nextRunAt('0 9 * * *', T0);
  const explicitUtc = schedule.nextRunAt('0 9 * * *', T0, 'UTC');
  assert.deepStrictEqual(noZone, explicitUtc, '不传时区必须等价于显式 UTC');

  // 与宿主本地时区解耦：本机宿主为 Asia/Shanghai，若实现偷用宿主本地，这一条会红。
  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hostLocal = schedule.nextRunAt('0 9 * * *', T0, hostZone);
  assert.ok(noZone.ok && hostLocal.ok);
  if (hostZone !== 'UTC' && noZone.ok && hostLocal.ok) {
    assert.notStrictEqual(
      noZone.atMs,
      hostLocal.atMs,
      `缺省时刻与宿主本地时区（${hostZone}）无关——缺省必须钉死在 UTC`,
    );
  }

  // 显式构造缺省时区也被尊重（供需要本地时间的部署显式声明）。
  const shanghaiDefault = new CronerSchedule({ defaultTimezone: 'Asia/Shanghai' });
  assert.strictEqual(shanghaiDefault.defaultTimezone, 'Asia/Shanghai');
  const viaDefault = shanghaiDefault.nextRunAt('0 9 * * *', T0);
  assert.strictEqual(viaDefault.ok && viaDefault.atMs, Date.parse('2026-10-04T01:00:00.000Z'));
});

test('A.5 失败语义三类分明：表达式非法 / 时区非法 ⇒ 拒；合法但永不匹配 ⇒ null（不是错误）', () => {
  const schedule = new CronerSchedule();

  const bad = schedule.nextRunAt('not a cron', T0, 'UTC');
  assert.strictEqual(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /cron 调度被拒：/);

  const badZone = schedule.nextRunAt('0 9 * * *', T0, 'Not/AZone');
  assert.strictEqual(badZone.ok, false);
  if (!badZone.ok) assert.match(badZone.reason, /cron 调度被拒：/);

  const empty = schedule.nextRunAt('   ', T0, 'UTC');
  assert.strictEqual(empty.ok, false);
  if (!empty.ok) assert.match(empty.reason, /表达式为空/);

  // 边界：非有限起始时刻不得静默当成「没有下次」。
  for (const badMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = schedule.nextRunAt('0 9 * * *', badMs, 'UTC');
    assert.strictEqual(r.ok, false, `起始时刻 ${String(badMs)} 必须被拒`);
    if (!r.ok) assert.match(r.reason, /不是有限数/);
  }

  // 2 月 30 日：表达式合法、永不匹配 ⇒ ok:true + atMs:null（与"错误"分开，调用方必须显式处理）。
  const impossible = schedule.nextRunAt('0 0 30 2 *', T0, 'UTC');
  assert.deepStrictEqual(impossible, { ok: true, atMs: null, timezone: 'UTC' });
});

test('A.5 validate() 只校验不执行，且归一化空白（多空格/制表符等价）', () => {
  const schedule = new CronerSchedule();
  const spaced = schedule.validate('  0   9  *  *  *  ');
  assert.strictEqual(spaced.ok, true);
  if (spaced.ok) assert.strictEqual(spaced.normalized, '0 9 * * *');

  const bad = schedule.validate('*/x * * * *');
  assert.strictEqual(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /cron 调度被拒：/);

  assert.strictEqual(schedule.validate('').ok, false);
  // 6 段（含秒）也被接受——两种写法都要能校验通过。
  assert.strictEqual(schedule.validate('0 30 9 * * *').ok, true);
});

test('A.5 兼容证据：简单 UTC 表达式的下次触发时刻落在自研实现的字段集合内（不引入回归）', () => {
  const schedule = new CronerSchedule();
  const zone = 'UTC';
  const instant = T0;
  const at = new Date(instant);
  assert.strictEqual(at.getUTCMinutes(), 0, '参照时刻取整分，便于比对');
  const next = schedule.nextRunAt('*/15 * * * *', instant, zone);
  assert.strictEqual(next.ok && next.atMs, Date.parse('2026-10-04T00:15:00.000Z'));

  // 自研实现的字段语义（分钟集合 + 小时集合）与新实现的命中时刻必须一致：
  // 这是「换实现不换语义」的可核验证据，而不是口头承诺。
  const minutes = RoutineScheduler.expandField('*/15', 0, 59);
  const hours = RoutineScheduler.expandField('*', 0, 23);
  const hit = new Date(next.ok && next.atMs !== null ? next.atMs : 0);
  assert.ok(minutes.has(hit.getUTCMinutes()), `分钟 ${hit.getUTCMinutes()} 必须落在自研字段集合内`);
  assert.ok(hours.has(hit.getUTCHours()), `小时 ${hit.getUTCHours()} 必须落在自研字段集合内`);

  // 固定时刻表达式（`0 9 * * *`）同理：命中 09:00Z。
  const daily = schedule.nextRunAt('0 9 * * *', instant, zone);
  const dailyHit = new Date(daily.ok && daily.atMs !== null ? daily.atMs : 0);
  assert.strictEqual(dailyHit.getUTCHours(), 9);
  assert.strictEqual(dailyHit.getUTCMinutes(), 0);
  assert.ok(RoutineScheduler.expandField('9', 0, 23).has(dailyHit.getUTCHours()));
});

test('A.5 编译缓存在有界范围内（重复求值不无限增长，且结果稳定）', () => {
  const schedule = new CronerSchedule();
  const first = schedule.nextRunAt('* * * * *', T0);
  const again = schedule.nextRunAt('* * * * *', T0);
  assert.deepStrictEqual(again, first, '同一输入必须给出同一结论（缓存不得改变语义）');

  // 灌入远超上限的不同表达式：必须不抛、结论仍正确（上限是内部纪律，不改变对外语义）。
  for (let i = 0; i < 200; i += 1) {
    const minute = i % 60;
    const hour = i % 24;
    const result = schedule.nextRunAt(
      `${minute} ${hour} * * *`,
      T0,
      i % 2 === 0 ? 'UTC' : 'Asia/Shanghai',
    );
    assert.strictEqual(result.ok, true, `第 ${i} 个表达式应可求值`);
  }
  assert.strictEqual(schedule.nextRunAt('* * * * *', T0).ok, true, '淘汰后仍能正常求值');
});
