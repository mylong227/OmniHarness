/** ContextAssembler 增量投影：复用前缀后必须与全量重投影逐条相同（2026-10-21）。 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ContextAssembler } from '../../src/context/contextAssembler.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';

function event(
  id: string,
  type: SessionEvent['type'],
  payload: Record<string, unknown>,
): SessionEvent {
  return { id, type, sessionId: 's', timestamp: '2026-10-21T00:00:00.000Z', payload };
}

const base: SessionEvent[] = [
  event('e1', 'user', { content: '请修 bug' }),
  event('e2', 'assistant', { content: '先读文件' }),
  event('e3', 'tool_call', { callId: 'c1', name: 'read_file', args: { path: 'a.ts' } }),
  event('e4', 'tool_result', { callId: 'c1', ok: true, output: 'export const a = 1;' }),
];

test('前缀复用：追加事件后的投影与全量重投影逐条相等', () => {
  const incremental = new ContextAssembler(['SYS'], undefined);
  const first = incremental.build(base.slice(0, 2), ['frag']);
  assert.strictEqual(first.length, 4);

  const extended = [
    ...base,
    event('e5', 'assistant', { content: '开始改' }),
    event('e6', 'user', { content: '继续' }),
  ];
  const reused = incremental.build(extended, ['frag']);

  const fresh = new ContextAssembler(['SYS'], undefined).build(extended, ['frag']);
  assert.deepStrictEqual(reused, fresh);
});

test('回卷（事件变短）后不得复用陈旧投影', () => {
  const assembler = new ContextAssembler(['SYS'], undefined);
  assembler.build(base, ['frag']);
  const rewound = assembler.build(base.slice(0, 2), ['frag']);
  const fresh = new ContextAssembler(['SYS'], undefined).build(base.slice(0, 2), ['frag']);
  assert.deepStrictEqual(rewound, fresh);
});

test('动态系统片段变化时不得复用', () => {
  const assembler = new ContextAssembler(['SYS'], undefined);
  assembler.build(base, ['repo-map-v1']);
  const changed = assembler.build(base, ['repo-map-v2']);
  const fresh = new ContextAssembler(['SYS'], undefined).build(base, ['repo-map-v2']);
  assert.deepStrictEqual(changed, fresh);
});
