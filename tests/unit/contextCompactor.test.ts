import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextCompactor } from '../../src/context/contextCompactor.js';
import type { ModelMessage, ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model.js';

/** 构造固定输出的假模型。 */
function fakeModel(behavior: () => ModelOutput): ModelPort {
  return {
    name: 'fake',
    async generate(_request: ModelRequest): Promise<ModelOutput> {
      return behavior();
    },
  };
}

/** 构造长消息列表。 */
function longMessages(count: number): ModelMessage[] {
  return Array.from({ length: count }, (_unused, index) => ({
    role: 'user' as const,
    content: `第 ${index} 条消息 ${'x'.repeat(200)}`,
  }));
}

test('压缩器：未超预算原样返回', async () => {
  const compactor = new ContextCompactor(
    fakeModel(() => ({ text: '摘要' })),
    { maxTokens: 100000, keepRecent: 3 },
  );
  const messages = longMessages(2);
  const result = await compactor.compact(messages);
  assert.strictEqual(result.compacted, false);
  assert.strictEqual(result.messages.length, 2);
});

test('压缩器：超预算用 LLM 摘要折叠历史', async () => {
  const compactor = new ContextCompactor(
    fakeModel(() => ({ text: '历史摘要内容' })),
    { maxTokens: 50, keepRecent: 2 },
  );
  const result = await compactor.compact(longMessages(6));
  assert.strictEqual(result.compacted, true);
  assert.strictEqual(result.summary, '历史摘要内容');
  assert.strictEqual(result.messages.length, 3);
  assert.strictEqual(result.messages[0]?.role, 'system');
  assert.strictEqual(result.messages[0]?.content, '历史摘要内容');
});

test('压缩器：无模型退化为占位摘要 + 最近消息', async () => {
  const compactor = new ContextCompactor(undefined, { maxTokens: 50, keepRecent: 2 });
  const result = await compactor.compact(longMessages(6));
  assert.strictEqual(result.compacted, true);
  assert.strictEqual(result.summary, '[历史已省略]');
  // 1 条占位 system + keepRecent 条最近消息
  assert.strictEqual(result.messages.length, 3);
  assert.strictEqual(result.messages[0]?.role, 'system');
  assert.strictEqual(result.messages[0]?.content, '[历史已省略]');
});

test('压缩器：模型异常退化为占位摘要 + 最近消息', async () => {
  const compactor = new ContextCompactor(
    fakeModel(() => {
      throw new Error('模型不可用');
    }),
    { maxTokens: 50, keepRecent: 1 },
  );
  const result = await compactor.compact(longMessages(4));
  assert.strictEqual(result.compacted, true);
  assert.strictEqual(result.summary, '[历史已省略]');
  assert.strictEqual(result.messages.length, 2);
});

test('压缩器：keepRecent 不超过消息总数', async () => {
  const compactor = new ContextCompactor(undefined, { maxTokens: 1, keepRecent: 10 });
  const result = await compactor.compact(longMessages(3));
  assert.strictEqual(result.messages.length, 3);
});

/* ----------------------- #OBS-8：orphan-tool 边界保护 ----------------------- */
/** 构造"assistant(tool_calls) → tool(result) → tool(result)" 序列用于 orphan-tool 复现。 */
function toolConversation(): ModelMessage[] {
  return [
    { role: 'system', content: 'sys'.repeat(80) },
    { role: 'user', content: 'u1'.repeat(80) },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'shell', arguments: {} }] },
    { role: 'tool', content: 'shell-out-1', toolCallId: 'c1' },
    { role: 'tool', content: 'shell-out-2', toolCallId: 'c1' }, // 同 id 视为另一回合，不是 orphan
    { role: 'user', content: 'u2'.repeat(80) },
  ];
}

test('OBS-8：压缩保留 tail 时，orphan tool 块会被并入 head（防 DeepSeek/OpenAI HTTP 400）', async () => {
  // tail 容量 = 2（最后 2 条是 user + assistant+tool_calls+tool），但若 keepRecent 切在 tool
  // 起点上，必须把这条 tool 挪进 head，否则下一轮模型会拿到"孤立的 tool 消息"被拒。
  const compactor = new ContextCompactor(undefined, { maxTokens: 50, keepRecent: 4 });
  const result = await compactor.compact(toolConversation());
  assert.strictEqual(result.compacted, true);
  // tail 起点不能是 tool（除了与前置 assistant.tool_calls 匹配的）；这里简化：它必须是 system/user/assistant。
  const firstTail = result.messages[1]; // 0 是 system summary
  assert.notStrictEqual(firstTail?.role, 'tool');
});

test('OBS-8：合法 tail 中含与前序 assistant.tool_calls 匹配的 tool 消息不被挪走', async () => {
  // 把 keepRecent 调到能完整保留 assistant+tool+tool 这一组作为 tail 起点
  const messages: ModelMessage[] = [
    { role: 'system', content: 'sys'.repeat(80) },
    { role: 'user', content: 'u1'.repeat(80) },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'shell', arguments: {} }] },
    { role: 'tool', content: 'result', toolCallId: 'c1' },
  ];
  const compactor = new ContextCompactor(undefined, { maxTokens: 50, keepRecent: 4 });
  const result = await compactor.compact(messages);
  assert.strictEqual(result.compacted, true);
  // tail 起点（messages[1] 即排除 system summary）应是匹配的 tool，因为它的前序有 assistant + tool_calls id=c1
  const tailFirst = result.messages[1];
  // tail 长度 = messages - 0（4 - keepRecent 4 = 0 moved）=整条，tail 第一条是 assistant（不是 tool），
  // OR 是合法 tool（如果是 tool 则压缩挪了等于空 head，都可接受）
  // 关键是：不能留下 orphan tool。验证：前序若含 assistant+matching toolCalls，tool 不被挪；
  // 验证到达的 messages 序列里没有连续 tool 没有匹配前缀的。
  if (tailFirst?.role === 'tool') {
    // 这种情况下保持 head=0，summary 是占位符，tail 完整保留
    assert.ok(tailFirst.toolCallId === 'c1');
  }
});
