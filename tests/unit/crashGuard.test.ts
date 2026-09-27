/**
 * 进程级崩溃护栏单测（§22.7 第 5 条收口，2026-09-27）。
 *
 * 为什么不用真 `process`：真进程里跑「未捕获异常」会把测试进程带走。护栏把目标进程与退出出口
 * 都做成注入项，正是为了让这几条**致命路径**能在单测里被完整验证（含「收尾抛错/悬挂也必须退出」）。
 *
 * 覆盖口径（每条都对应护栏 JSDoc 里的一句承诺，缺一句即红）：
 *  ① 浮动 rejection：报告 + 继续运行（不退出），计数累加；
 *  ② 连达上限：升级为致命路径 → 收尾 + 退出码 1（避免「带病无限运行」）；
 *  ③ 未捕获异常：报告 + 收尾 + 退出码 1（fail-closed）；
 *  ④ SIGINT / SIGTERM：收尾 + 约定退出码 130 / 143；
 *  ⑤ 收尾抛错、收尾悬挂：都不得阻塞退出（宽限到点即退）；
 *  ⑥ 收尾只做一次（第二次致命事件不再重复收尾）；
 *  ⑦ 接线守卫：`src/cli/exec.ts` 必须真的安装护栏（防「声明未接线」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CrashGuard, type CrashGuardTarget, type CrashReport } from '../../src/cli/crashGuard.js';

/** 记录型假进程：只实现护栏用到的 `on` / `exit`。 */
class FakeProcess implements CrashGuardTarget {
  /** 事件名 → 监听器列表。 */
  public readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  /** 收到的退出码（未退出为空数组）。 */
  public readonly exits: number[] = [];

  /**
   * 注册监听。
   * @param event 事件名。
   * @param listener 监听器。
   * @returns 自身（与真 `process` 的可链式返回对齐）。
   */
  public on(event: string, listener: (...args: unknown[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  /**
   * 记录退出。
   * @param code 退出码。
   * @returns 无返回值。
   */
  public exit(code: number): void {
    this.exits.push(code);
  }

  /**
   * 触发某事件的所有监听器。
   * @param event 事件名。
   * @param args 事件参数。
   * @returns 无返回值。
   */
  public fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

/** 造一个已安装护栏的假进程 + 报告收集器（统一六个用例的样板）。 */
const harness = (
  over: Partial<Parameters<typeof CrashGuard.install>[0]> = {},
): { proc: FakeProcess; reports: CrashReport[]; guard: CrashGuard } => {
  const proc = new FakeProcess();
  const reports: CrashReport[] = [];
  const guard = CrashGuard.install({
    proc,
    report: (r) => reports.push(r),
    ...over,
  });
  return { proc, reports, guard };
};

/** 让已排队的微任务跑完（护栏的致命路径是异步收尾）。 */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

test('① 浮动 rejection：报告 + 继续运行（不退出），计数累加', async () => {
  const { proc, reports, guard } = harness();
  proc.fire('unhandledRejection', new Error('后台任务炸了'));
  proc.fire('unhandledRejection', '字符串原因');
  await settle();
  assert.strictEqual(reports.length, 2);
  assert.strictEqual(reports[0]?.kind, 'unhandledRejection');
  assert.match(reports[0]?.message ?? '', /后台任务炸了/);
  assert.strictEqual(reports[1]?.message, '字符串原因', '非 Error 也要能读成文本');
  assert.deepStrictEqual(proc.exits, [], '低于上限不得退出（一条浮动 rejection 不该带走会话）');
  assert.strictEqual(guard.rejectionCount, 2);
});

test('② 连达上限：升级为致命路径（收尾 + 退出码 1）', async () => {
  let shutdowns = 0;
  const { proc, reports } = harness({
    maxRejections: 3,
    shutdown: () => {
      shutdowns += 1;
    },
  });
  for (let i = 0; i < 3; i += 1) {
    proc.fire('unhandledRejection', new Error(`第 ${String(i)} 条`));
  }
  await settle();
  assert.deepStrictEqual(proc.exits, [1], '上限达标必须升级为致命（防带病无限运行）');
  assert.strictEqual(shutdowns, 1, '收尾恰一次');
  assert.match(reports[reports.length - 1]?.message ?? '', /上限 3/);
});

test('③ 未捕获异常：报告 + 收尾 + 退出码 1（fail-closed）', async () => {
  let shutdowns = 0;
  const { proc, reports } = harness({
    shutdown: () => {
      shutdowns += 1;
    },
  });
  proc.fire('uncaughtException', new Error('栈已不可信'));
  await settle();
  assert.strictEqual(reports[0]?.kind, 'uncaughtException');
  assert.strictEqual(shutdowns, 1);
  assert.deepStrictEqual(proc.exits, [1]);
});

test('④ SIGINT / SIGTERM：收尾 + 约定退出码 130 / 143', async () => {
  const { proc, reports } = harness({ shutdown: () => undefined });
  proc.fire('SIGINT');
  await settle();
  assert.deepStrictEqual(proc.exits, [130]);
  assert.strictEqual(reports[0]?.kind, 'signal');
  assert.match(reports[0]?.message ?? '', /SIGINT/);
});

test('⑤ 收尾抛错 / 收尾悬挂：都不得阻塞退出（宽限到点即退）', async () => {
  const throwing = harness({
    shutdown: () => {
      throw new Error('收尾自己炸了');
    },
  });
  throwing.proc.fire('uncaughtException', new Error('原始失败'));
  await settle();
  assert.deepStrictEqual(throwing.proc.exits, [1], '收尾抛错不得阻塞退出');
  assert.ok(
    throwing.reports.some((r) => r.message.includes('收尾钩子自身失败')),
    '收尾失败必须留痕（不得静默）',
  );

  const hanging = harness({
    graceMs: 10,
    shutdown: () => new Promise<void>(() => undefined),
  });
  hanging.proc.fire('SIGTERM');
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 40);
  });
  assert.deepStrictEqual(hanging.proc.exits, [143], '收尾悬挂必须在宽限到点后强退');
});

test('⑥ 收尾只做一次：第二条致命事件不再重复收尾', async () => {
  let shutdowns = 0;
  const { proc } = harness({
    shutdown: () => {
      shutdowns += 1;
    },
  });
  proc.fire('SIGINT');
  await settle();
  proc.fire('SIGTERM');
  proc.fire('uncaughtException', new Error('再来一条'));
  await settle();
  assert.strictEqual(shutdowns, 1);
  assert.deepStrictEqual(proc.exits, [130], '已在退出流程中就不再叠加退出码');
});

test('⑦ 接线守卫：CLI 入口必须真的安装护栏（防「声明未接线」）', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..', '..', '..');
  const src = readFileSync(join(root, 'src', 'cli', 'exec.ts'), 'utf8');
  assert.match(
    src,
    /CrashGuard\.install\(/,
    'exec.ts 必须安装 CrashGuard（§22.7 第 5 条的接线点）',
  );
  assert.match(src, /import\('\.\/crashGuard\.js'\)/, '护栏须走动态 import（不得拖慢快速路径）');
  // 护栏自身不得有安装副作用：库调用方 import 它不应改变进程行为（故不得出现入口判定）。
  const guard = readFileSync(join(root, 'src', 'cli', 'crashGuard.ts'), 'utf8');
  assert.ok(!/isEntry/.test(guard), 'crashGuard.ts 只应声明能力，不得自我安装');
});
