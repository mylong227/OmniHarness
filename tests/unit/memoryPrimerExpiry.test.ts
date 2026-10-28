/**
 * 记忆 primer 失效过滤（2026-10-28）。
 *
 * 缺陷现场：`injectMemoryPrimer` 的「无召回命中」fallback 直接读 `all()` 按 importance 取 top-5，
 * **没有过滤 `expiresAt`**。冲突消解（supersede）把旧事实置为过期后，开场注入又把旧值灌回去——
 * 与 `TimeDecay.isExpired` 的口径（`<= now`）不一致，等于让「已被替代的旧值」在每会话开场复活。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.ts';
import { SessionRecorder } from '../../src/core/sessionRecorder.ts';
import { SessionInjector } from '../../src/core/sessionInjector.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/memory/longTermMemory.ts';

/** 构造一条事实：`expiresAt` 可选。 */
function fact(id: string, text: string, importance: number, expiresAt?: string): MemoryFact {
  return {
    id,
    text,
    importance,
    createdAt: '2026-01-01T00:00:00.000Z',
    sessionId: 'other',
    source: 'consolidated',
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** 固定桩：`recall` 恒空，强制走 fallback（正是缺陷所在分支）。 */
class NoHitMemory implements LongTermMemoryPort {
  public readonly name = 'no-hit';
  public constructor(private readonly facts: readonly MemoryFact[]) {}
  public recall(): readonly MemoryFact[] {
    return [];
  }
  public all(): readonly MemoryFact[] {
    return this.facts;
  }
  public get count(): number {
    return this.facts.length;
  }
  public get(id: string): MemoryFact | undefined {
    return this.facts.find((entry) => entry.id === id);
  }
  public remember(): void {}
  public update(): boolean {
    return false;
  }
  public delete(): boolean {
    return false;
  }
}

test('fallback 分支不得注入已过期事实（expiresAt <= now）', () => {
  const previous = process.env.OMNI_MEMORY_PRIMER;
  process.env.OMNI_MEMORY_PRIMER = '1';
  try {
    const log = new AppendOnlyEventLog();
    const recorder = new SessionRecorder(log, new SilentEventPort(), 's1');
    const injector = new SessionInjector({
      longTermMemory: new NoHitMemory([
        // 高重要度但已过期：旧实现会优先注入它（正是要拦的形态）。
        fact('old', 'EXPIRED_OLD_VALUE', 5, '2020-01-01T00:00:00.000Z'),
        // 低重要度但有效：必须仍在。
        fact('new', 'LIVE_NEW_VALUE', 1),
      ]),
    });
    injector.open(recorder, log, 'hello', 's1');
    const system = log
      .byType('system')
      .map((event) => String((event.payload as { content?: unknown }).content ?? ''))
      .join('\n');
    assert.doesNotMatch(system, /EXPIRED_OLD_VALUE/u, '过期事实不得进入 primer');
    assert.match(system, /LIVE_NEW_VALUE/u, '有效事实仍应进入 primer');
  } finally {
    if (previous === undefined) delete process.env.OMNI_MEMORY_PRIMER;
    else process.env.OMNI_MEMORY_PRIMER = previous;
  }
});
