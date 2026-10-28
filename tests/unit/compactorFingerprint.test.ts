/**
 * F3：压缩游标指纹的「单条缓存 + 前缀折叠」必须与原 djb2 **逐位一致**。
 *
 * 缓存按消息对象身份；消息内容被替换或原地修改时必须重算（否则游标复用的
 * `headHash` 会与旧内容绑定，导致错误的快路径复用）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ContextCompactor } from '../../src/context/contextCompactor.ts';
import type { ModelMessage } from '../../src/ports/model/modelMessage.ts';

/** 旧实现（参考口径；2026-10-28 起含 toolCalls）。 */
function reference(messages: readonly ModelMessage[]): string {
  let h = 5381;
  for (const m of messages) {
    const toolCallsKey = m.toolCalls === undefined ? '' : JSON.stringify(m.toolCalls);
    const s = `${m.role}\u0000${m.content}\u0000${m.toolCallId ?? ''}\u0000${toolCallsKey}`;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

test('headFingerprint：随机消息与原 djb2 逐位一致', () => {
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let round = 0; round < 50; round += 1) {
    const count = next() % 20;
    const messages: ModelMessage[] = Array.from({ length: count }, () => ({
      role: (['user', 'assistant', 'tool'] as const)[next() % 3] ?? 'user',
      content: 'x'.repeat(next() % 80),
      ...(next() % 2 === 0 ? { toolCallId: `call_${String(next() % 9)}` } : {}),
    }));
    assert.strictEqual(ContextCompactor.headFingerprint(messages), reference(messages));
  }
});

test('headFingerprint：同一对象内容被原地修改后必须重算', () => {
  const message = { role: 'user', content: 'alpha' } as ModelMessage & { content: string };
  const first = ContextCompactor.headFingerprint([message]);
  message.content = 'beta';
  const second = ContextCompactor.headFingerprint([message]);
  assert.notStrictEqual(first, second);
  assert.strictEqual(second, reference([message]));
});

test('headFingerprint：大前缀 warm 调用保持正确（缓存折叠）', () => {
  const messages: ModelMessage[] = Array.from({ length: 800 }, (_, index) => ({
    role: index % 3 === 0 ? 'assistant' : 'user',
    content: `message-${String(index)}-${'z'.repeat(120)}`,
  }));
  const first = ContextCompactor.headFingerprint(messages);
  const second = ContextCompactor.headFingerprint(messages);
  assert.strictEqual(second, first);
  assert.strictEqual(second, reference(messages));
});

test('headFingerprint：toolCalls 的入参必须进指纹（只改 args 也要变）', () => {
  const base = {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'a', name: 'read_file', arguments: { path: 'a.ts' } }],
  } as ModelMessage;
  const same = {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'a', name: 'read_file', arguments: { path: 'a.ts' } }],
  } as ModelMessage;
  const changed = {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'a', name: 'read_file', arguments: { path: 'b.ts' } }],
  } as ModelMessage;
  assert.strictEqual(
    ContextCompactor.headFingerprint([base]),
    ContextCompactor.headFingerprint([same]),
  );
  assert.notStrictEqual(
    ContextCompactor.headFingerprint([base]),
    ContextCompactor.headFingerprint([changed]),
    '只改工具入参时指纹必须变，否则会复用按旧参数折叠的摘要',
  );
  assert.strictEqual(ContextCompactor.headFingerprint([changed]), reference([changed]));
});

test('headFingerprint：同一消息对象原地改 toolCalls 后必须重算', () => {
  const message = {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'a', name: 'read_file', arguments: { path: 'a.ts' } }],
  } as ModelMessage & {
    toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  };
  const first = ContextCompactor.headFingerprint([message]);
  message.toolCalls[0]!.arguments['path'] = 'b.ts';
  const second = ContextCompactor.headFingerprint([message]);
  assert.notStrictEqual(first, second);
  assert.strictEqual(second, reference([message]));
});
