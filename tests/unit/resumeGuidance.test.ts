/** 续跑引导：必须带可区分的目标，而不只是工具名（2026-10-21）。 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ResumeGuidance } from '../../src/core/resumeGuidance.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';

function call(id: string, name: string, args: Record<string, unknown>): SessionEvent {
  return {
    id: `c-${id}`,
    type: 'tool_call',
    sessionId: 's',
    timestamp: '2026-10-21T00:00:00.000Z',
    payload: { callId: id, name, args },
  };
}

function result(id: string, ok: boolean): SessionEvent {
  return {
    id: `r-${id}`,
    type: 'tool_result',
    sessionId: 's',
    timestamp: '2026-10-21T00:00:01.000Z',
    payload: { callId: id, ok },
  };
}

test('续跑引导：写类调用列出目标路径，同名不同目标可区分', () => {
  const text = ResumeGuidance.build([
    call('1', 'write_file', { path: 'src/a.ts' }),
    result('1', true),
    call('2', 'write_file', { path: 'src/a.ts' }),
    result('2', true),
    call('3', 'shell', { command: 'pnpm test' }),
    result('3', true),
    call('4', 'read_file', { path: 'src/a.ts' }),
    result('4', true),
    call('5', 'write_file', { path: 'src/b.ts' }),
    result('5', false),
  ]);
  assert.match(text, /write_file src\/a\.ts/);
  assert.match(text, /shell pnpm test/);
  assert.doesNotMatch(text, /read_file/);
  assert.doesNotMatch(text, /src\/b\.ts/, '失败的写类调用不得进入完成清单');
  assert.strictEqual(text.match(/write_file src\/a\.ts/g)?.length, 1, '同一目标重复写只列一次');
});
