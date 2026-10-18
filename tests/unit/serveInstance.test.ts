/**
 * `serve` **实例记录**判据（2026-10-15，销看板 §8.17 那条"未修边界"：陈旧 serve 可存活 48 小时而无从识别）。
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | `announce` → `read` 往返自描述；脏记录一律当"无记录" | 半条记录冒充"上次是谁"，排障被带偏 |
 * | ② | `retire` **只删自己的**记录 | 顺手删掉别人（正在跑的实例）的记录，比陈旧更难查 |
 * | ③ | `sweep` 只清**已死**进程的记录，活着的原样保留 | 清掉正在跑的实例记录 / 让陈旧记录长期撒谎 |
 * | ④ | `isAlive` 把 **EPERM 当存活**（权限不足 ≠ 进程不在） | 把别的用户的 serve 判死并"接管" |
 * | ⑤ | `advice` 转述记录，并**明说与健康体一致/不一致**（不一致以健康体为准） | 拿陈旧记录圆场，把排障指向错的 PID |
 *
 * 全部离线：临时目录 + 注入探针，不真起服务（端到端接线在 `servePortConflictE2E.test.ts`）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServeInstance } from '../../src/cli/serveInstance.ts';
import { ServePortConflict } from '../../src/cli/servePortConflict.ts';

/**
 * 造一份记录。
 * @param over 覆盖字段
 * @returns 记录
 */
function record(over: Partial<Parameters<typeof ServeInstance.announce>[0]> = {}) {
  return {
    pid: process.pid,
    host: '127.0.0.1',
    port: 18787,
    startedAt: '2026-10-15T00:00:00.000Z',
    workspace: 'D:\\ws',
    version: '0.2.0',
    ...over,
  };
}

/**
 * 在临时目录里跑一段用例（每个用例自带家目录，互不干扰）。
 * @param fn 用例体（入参为临时家目录）
 * @returns 无返回值
 */
function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'omni-serve-instance-'));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('① announce/read：往返自描述；脏记录一律当"没有记录"（fail-closed）', () => {
  withHome((home) => {
    const path = ServeInstance.pathFor(18787, home);
    ServeInstance.announce(record(), path);
    assert.ok(existsSync(path), '应写出记录文件');
    const back = ServeInstance.read(path);
    assert.deepStrictEqual(back, record(), '往返必须逐字段一致');

    // 缺失 ⇒ null（不是抛错）
    assert.strictEqual(ServeInstance.read(join(home, 'nope.pid')), null);
    // 非 JSON / 非对象 / 缺 pid / pid 非法 / 缺 port ⇒ 全部当"没有记录"
    const dirty: readonly string[] = [
      '{ not json',
      '[]',
      '{"port":1}',
      '{"pid":0,"port":1}',
      '{"pid":-3,"port":1}',
      '{"pid":1.5,"port":1}',
      '{"pid":"1","port":1}',
      '{"pid":1}',
    ];
    for (const text of dirty) {
      writeFileSync(path, text, 'utf8');
      assert.strictEqual(ServeInstance.read(path), null, `脏记录必须返回 null：${text}`);
    }
    // 正对照：把同一份内容写对 ⇒ 立刻读得出来（证明上面不是"read 恒 null"）。
    writeFileSync(path, JSON.stringify(record()), 'utf8');
    assert.notStrictEqual(ServeInstance.read(path), null);
  });
});

test('② retire：只删自己的记录（别人的记录必须原样留着）', () => {
  withHome((home) => {
    const path = ServeInstance.pathFor(18787, home);
    ServeInstance.announce(record({ pid: process.pid + 1 }), path);
    assert.strictEqual(ServeInstance.retire(path), false, '不是自己的记录不得删');
    assert.ok(existsSync(path), '别人的记录必须还在');
    ServeInstance.announce(record({ pid: process.pid }), path);
    assert.strictEqual(ServeInstance.retire(path), true, '自己的记录应删掉');
    assert.strictEqual(existsSync(path), false);
    // 幂等：没有记录时 retire 不抛错、返回 false
    assert.strictEqual(ServeInstance.retire(path), false);
  });
});

test('③ sweep：只清已死进程的记录，活着的原样保留（注入探针，两条分支都覆盖）', () => {
  withHome((home) => {
    const path = ServeInstance.pathFor(18787, home);
    ServeInstance.announce(record({ pid: 4242 }), path);
    // 活着 ⇒ 不动
    const live = ServeInstance.sweep(path, () => true);
    assert.strictEqual(live.swept, false);
    assert.strictEqual(live.record?.pid, 4242, '活着的记录要回报给调用方（用于提示里转述）');
    assert.ok(existsSync(path), '活着的记录不得被删');
    // 已死 ⇒ 删掉并回报
    const dead = ServeInstance.sweep(path, () => false);
    assert.strictEqual(dead.swept, true);
    assert.strictEqual(dead.record?.pid, 4242);
    assert.strictEqual(existsSync(path), false, '已死的记录必须被清掉（自愈）');
    // 没有记录 ⇒ 什么都不做
    const none = ServeInstance.sweep(path, () => true);
    assert.strictEqual(none.swept, false);
    assert.strictEqual(none.record, null);
  });
});

test('④ isAlive：EPERM 视为存活、ESRCH 视为已死（权限不足 ≠ 进程不在）', () => {
  // 本进程必然存活（真实探测）。
  assert.strictEqual(ServeInstance.isAlive(process.pid), true);
  // 注入探针覆盖两条分支：EPERM ⇒ 存活；ESRCH ⇒ 已死。
  const eperm = (): never => {
    const error = new Error('operation not permitted') as NodeJS.ErrnoException;
    error.code = 'EPERM';
    throw error;
  };
  const esrch = (): never => {
    const error = new Error('no such process') as NodeJS.ErrnoException;
    error.code = 'ESRCH';
    throw error;
  };
  assert.strictEqual(
    ServeInstance.isAlive(4242, eperm),
    true,
    'EPERM 说明进程在、只是不属于我们 —— 判死会导致"接管别人的服务"',
  );
  assert.strictEqual(ServeInstance.isAlive(4242, esrch), false);
  // 非法 pid 直接判死，连探针都不调（防把 0/NaN 当"存活"）。
  let probed = 0;
  assert.strictEqual(
    ServeInstance.isAlive(0, () => {
      probed += 1;
    }),
    false,
  );
  assert.strictEqual(probed, 0, '非法 pid 不应触发探测');
});

test('⑤ advice：转述实例记录并明说与健康体一致/不一致（不一致以健康体为准）', () => {
  const recordOf = {
    pid: 111,
    host: '127.0.0.1',
    port: 8787,
    startedAt: '2026-10-15T01:00:00.000Z',
    workspace: 'D:\\proj',
    version: '0.2.0',
  };
  // 一致：转述 + 三条出路都在
  const same = ServePortConflict.advice(8787, { kind: 'omni', pid: 111, detail: 'd' }, recordOf);
  assert.match(same, /实例记录：pid=111/u);
  assert.match(same, /D:\\proj/u, '记录里必须带工作区（排障第一问）');
  assert.match(same, /--take-port/u, '原有三条出路不得因为加了一行而消失');
  // 不一致：必须显式点出来，且明说以健康体为准
  const diff = ServePortConflict.advice(8787, { kind: 'omni', pid: 222, detail: 'd' }, recordOf);
  assert.match(diff, /不一致/u);
  assert.match(diff, /以健康体为准/u);
  assert.match(diff, /222/u, '不一致时要同时给出记录与健康体两侧的 PID');
  // 占用者不是本程序却留有记录：以健康体为准（不得让记录把结论带偏）
  const foreign = ServePortConflict.advice(
    8787,
    { kind: 'foreign', detail: '别的 HTTP 服务' },
    recordOf,
  );
  assert.match(foreign, /以健康体为准/u);
  // 无记录且占用者是自己人：如实说"没有留下记录文件"，不编造
  const none = ServePortConflict.advice(8787, { kind: 'omni', pid: 111, detail: 'd' });
  assert.match(none, /没有留下记录文件/u);
  assert.doesNotMatch(none, /实例记录：/u, '无记录时不得凭空打一行"实例记录"');
  // 无记录且占用者是外人：不得提记录（那句只对 omni 有意义）
  const foreignNoRecord = ServePortConflict.advice(8787, { kind: 'foreign', detail: 'x' });
  assert.doesNotMatch(foreignNoRecord, /实例记录/u);
});

test('⑥ describe：缺字段时如实省略，不补默认值', () => {
  withHome((home) => {
    const path = ServeInstance.pathFor(18787, home);
    ServeInstance.announce(record({ startedAt: '', workspace: '' }), path);
    const back = ServeInstance.read(path);
    assert.ok(back !== null);
    const described = ServeInstance.describe(back);
    assert.match(described, /pid=\d+/u);
    assert.doesNotMatch(described, /启动于/u, '没有启动时刻就不要写"启动于"');
    assert.doesNotMatch(described, /工作区/u);
    assert.match(described, /serve-18787\.pid/u, '必须点明记录文件名，便于用户自己去看');
    // 写入的内容必须是可读 JSON（自描述：人直接 cat 也能看懂）
    assert.match(readFileSync(path, 'utf8'), /"workspace"/u);
  });
});
