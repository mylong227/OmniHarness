import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EvidenceLedger } from '../../src/core/evidenceLedger.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';

function event(type: string, payload: Record<string, unknown>): SessionEvent {
  return {
    id: `${type}-${String(Math.random())}`,
    sessionId: 's',
    seq: 0,
    ts: '',
    type,
    payload,
  } as unknown as SessionEvent;
}

test('VER-02：纯问答没有工具调用，不被惩罚', () => {
  assert.strictEqual(
    EvidenceLedger.hasCompletionEvidence([event('assistant', { content: 'hi' })]),
    true,
  );
});

test('VER-02：成功工具结果算证据，全部失败不算', () => {
  const call = event('tool_call', { callId: 'c1', name: 'read_file' });
  const ok = event('tool_result', { callId: 'c1', ok: true, output: 'x' });
  const fail = event('tool_result', { callId: 'c1', ok: false, error: 'x' });
  assert.strictEqual(EvidenceLedger.hasCompletionEvidence([call, ok]), true);
  assert.strictEqual(EvidenceLedger.hasCompletionEvidence([call, fail]), false);
  assert.deepStrictEqual(EvidenceLedger.summarize([call, ok]).successfulTools, ['read_file']);
});
