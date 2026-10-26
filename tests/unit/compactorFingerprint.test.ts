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

/** 旧实现（参考口径）。 */
function reference(messages: readonly ModelMessage[]): string {
  let h = 5381;
  for (const m of messages) {
    const s = `${m.role}\u0000${m.content}\u0000${m.toolCallId ?? ''}`;
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
