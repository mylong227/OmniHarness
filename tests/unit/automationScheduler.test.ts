/**
 * AutomationScheduler 判据（2026-10-27 审计收口）：单条任务失败**必须可观测**。
 *
 * 缺陷现场：catch 空吞错误且 lastRunAt 已先落——用户定义的定时自动化呈现
 * 「看起来在跑、实际每轮都失败」的假象，且排障无门。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AutomationScheduler } from '../../src/server/services/automationScheduler.ts';
import type { Automation, AutomationStore } from '../../src/server/services/automationStore.ts';

/** 内存任务存储桩（只实现调度器消费的两个方法）。 */
class MemoryAutomationStore {
  public readonly marked: string[] = [];
  public constructor(private readonly items: readonly Automation[]) {}
  public due(): readonly Automation[] {
    return this.items;
  }
  public markRun(id: string): void {
    this.marked.push(id);
  }
}

function automationOf(id: string): Automation {
  return { id, intervalMs: 1000, prompt: 'tick' } as unknown as Automation;
}

test('单条失败不影响其余任务，且 lastRunAt 照常先落', async () => {
  const first = automationOf('a');
  const second = automationOf('b');
  const store = new MemoryAutomationStore([first, second]);
  const ran: string[] = [];
  const scheduler = new AutomationScheduler(
    store as unknown as AutomationStore,
    async (automation) => {
      ran.push(automation.id);
      if (automation.id === 'a') throw new Error('boom');
    },
  );
  await scheduler.tick();
  assert.deepStrictEqual(ran, ['a', 'b'], '第一条失败不得中断第二条');
  assert.deepStrictEqual(store.marked, ['a', 'b'], '两条都要落 lastRunAt（防同窗重触发）');
});
