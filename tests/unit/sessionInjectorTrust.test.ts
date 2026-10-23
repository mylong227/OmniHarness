/**
 * 记忆 primer 信任过滤：trustedOnly 时 untrusted 事实不得进入开场 system。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.ts';
import { SessionRecorder } from '../../src/core/sessionRecorder.ts';
import { SessionInjector } from '../../src/core/sessionInjector.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/memory/longTermMemory.ts';

function fact(id: string, text: string, trust: 'trusted' | 'untrusted'): MemoryFact {
  return {
    id,
    text,
    importance: 4,
    createdAt: new Date().toISOString(),
    sessionId: 'other',
    source: 'consolidated',
    trust,
  };
}

class FakeMemory implements LongTermMemoryPort {
  public readonly name = 'fake';
  public constructor(private readonly facts: readonly MemoryFact[]) {}
  public recall(): readonly MemoryFact[] {
    return this.facts;
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

test('trustedOnly：untrusted 记忆不进入 primer', () => {
  const previous = process.env.OMNI_MEMORY_PRIMER;
  process.env.OMNI_MEMORY_PRIMER = '1';
  try {
    const log = new AppendOnlyEventLog();
    const recorder = new SessionRecorder(log, new SilentEventPort(), 's1');
    const injector = new SessionInjector({
      longTermMemory: new FakeMemory([
        fact('t', 'TRUSTED_FACT', 'trusted'),
        fact('u', 'UNTRUSTED_FACT', 'untrusted'),
      ]),
      trustedOnly: true,
    });
    injector.open(recorder, log, 'hello', 's1');
    const system = log
      .byType('system')
      .map((event) => String((event.payload as { content?: unknown }).content ?? ''))
      .join('\n');
    assert.match(system, /TRUSTED_FACT/u);
    assert.doesNotMatch(system, /UNTRUSTED_FACT/u);
  } finally {
    if (previous === undefined) delete process.env.OMNI_MEMORY_PRIMER;
    else process.env.OMNI_MEMORY_PRIMER = previous;
  }
});
