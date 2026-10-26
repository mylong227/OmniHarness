/**
 * F6：第二次折叠必须用「已有摘要 + 新增段」做种子，而不是把整段 head 重新摘要。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ContextCompactor } from '../../src/context/contextCompactor.ts';
import type {
  ModelMessage,
  ModelOutput,
  ModelPort,
  ModelRequest,
} from '../../src/ports/model/model.ts';

/** 记录每次摘要请求的模型桩。 */
class SpyModel implements ModelPort {
  public readonly name = 'spy';
  public readonly requests: ModelRequest[] = [];
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.requests.push(request);
    return { text: `摘要-${String(this.requests.length)}` };
  }
}

/** 造长消息，确保触发压缩。 */
function longMessages(count: number): ModelMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `m${String(index)}-${'x'.repeat(300)}`,
  }));
}

test('F6：二次折叠摘要请求带已有摘要，且新增段小于全量 head', async () => {
  const model = new SpyModel();
  const compactor = new ContextCompactor(model, { maxTokens: 1_200, keepRecent: 2 });
  const base: ModelMessage[] = [{ role: 'system', content: 'SYS' }, ...longMessages(30)];
  const first = await compactor.compact(base);
  assert.ok(first.state !== undefined);
  const firstPromptMessages = model.requests[0]?.messages.length ?? 0;

  const grown = [
    ...base,
    ...longMessages(30).map((m, i) => ({ ...m, content: `${m.content}-g${String(i)}` })),
  ];
  const second = await compactor.compact(grown, first.state);
  assert.strictEqual(model.requests.length, 2, '二次折叠应再调一次摘要模型');
  const secondRequest = model.requests[1];
  assert.ok(secondRequest !== undefined);
  const seed = secondRequest.messages.find(
    (m) => m.role === 'system' && m.content.includes('【已有摘要】'),
  );
  assert.ok(seed !== undefined, '第二次摘要必须带已有摘要种子');
  assert.match(seed.content, /摘要-1/);
  assert.ok(
    secondRequest.messages.length < firstPromptMessages + 30,
    `种子路径应少于「全量 head」消息数（实际 ${String(secondRequest.messages.length)}）`,
  );
  assert.strictEqual(second.summary, '摘要-2', '摘要应更新为覆盖更长历史的新摘要');
});
