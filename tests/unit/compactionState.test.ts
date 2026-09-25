import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextCompactor } from '../../src/context/contextCompactor.js';
import type {
  ModelMessage,
  ModelOutput,
  ModelPort,
  ModelRequest,
} from '../../src/ports/model/model.js';

/** 计数假模型：统计 generate 调用次数（验证游标复用零 LLM 调用）。 */
function countingModel(text: string) {
  let calls = 0;
  const model: ModelPort = {
    name: 'fake',
    async generate(_request: ModelRequest): Promise<ModelOutput> {
      calls += 1;
      return { text };
    },
  };
  return { model, getCalls: () => calls };
}

function longMessages(count: number): ModelMessage[] {
  return Array.from({ length: count }, (_unused, index) => ({
    role: 'user' as const,
    content: `第 ${index} 条消息 ${'x'.repeat(200)}`,
  }));
}

test('压缩游标：state 命中时复用摘要，零 LLM 调用（P0-1 修复锁）', async () => {
  const { model, getCalls } = countingModel('结构化摘要');
  const compactor = new ContextCompactor(model, { maxTokens: 50, keepRecent: 2 });
  const messages = longMessages(6);

  const first = await compactor.compact(messages);
  assert.strictEqual(first.compacted, true);
  assert.ok(first.state !== undefined);
  const callsAfterFirst = getCalls();

  // 第二次压缩（新一步）传回 state：必须不再调 LLM，且产出与首次等价。
  const second = await compactor.compact(messages, first.state);
  assert.strictEqual(second.compacted, true);
  assert.strictEqual(second.summary, first.summary);
  assert.strictEqual(second.state, first.state);
  assert.strictEqual(getCalls(), callsAfterFirst, '命中游标后不应再调摘要模型');
  assert.deepStrictEqual(second.messages, first.messages);
});

test('压缩游标：前缀漂移（headHash 不匹配）自动失效重算', async () => {
  const { model, getCalls } = countingModel('重算摘要');
  const compactor = new ContextCompactor(model, { maxTokens: 50, keepRecent: 2 });
  const first = await compactor.compact(longMessages(6));
  assert.ok(first.state !== undefined);

  // 构造伪造 state：upTo 相同但 hash 错误 → 必须重算（LLM 再调一次）。
  const stale = { ...first.state, headHash: 'deadbeef' };
  const callsBefore = getCalls();
  const second = await compactor.compact(longMessages(6), stale);
  assert.strictEqual(getCalls(), callsBefore + 1);
  assert.strictEqual(second.state?.headHash, first.state.headHash);
});

test('压缩状态编解码：roundtrip 一致，坏格式 fail-closed 返回 undefined', () => {
  const state = { compactedUpTo: 12, headHash: 'ab12cd', summary: '任务：写测试\n进度：过半' };
  const encoded = ContextCompactor.encodeCompactionState(state);
  assert.ok(encoded.startsWith('OMNI_COMPACTION_V1 upTo=12 hash=ab12cd\n'));
  const decoded = ContextCompactor.decodeCompactionState(encoded);
  assert.deepStrictEqual(decoded, state);

  assert.strictEqual(ContextCompactor.decodeCompactionState('乱七八糟'), undefined);
  assert.strictEqual(
    ContextCompactor.decodeCompactionState('OMNI_COMPACTION_V1 upTo=x hash=zz\n正文'),
    undefined,
  );
  assert.strictEqual(
    ContextCompactor.decodeCompactionState('OMNI_COMPACTION_V1 upTo=1 hash=ab\n'),
    undefined,
  );
});

test('前缀指纹：内容相同指纹相同，内容变化指纹变化', () => {
  const a: ModelMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  assert.strictEqual(ContextCompactor.headFingerprint(a), ContextCompactor.headFingerprint([...a]));
  assert.notStrictEqual(
    ContextCompactor.headFingerprint(a),
    ContextCompactor.headFingerprint([{ role: 'user', content: 'hellp' }]),
  );
  // toolCallId 纳入指纹
  const withCall: ModelMessage[] = [{ role: 'assistant', content: '', toolCallId: 't1' }];
  const withCall2: ModelMessage[] = [{ role: 'assistant', content: '', toolCallId: 't2' }];
  assert.notStrictEqual(
    ContextCompactor.headFingerprint(withCall),
    ContextCompactor.headFingerprint(withCall2),
  );
});

test('压缩器：contextWindowTokens 提供时阈值 = 0.8×window 优先', async () => {
  // window=100 → 阈值 80；6 条 200 字消息（远超 80）必须触发压缩。
  const { model } = countingModel('摘要');
  const compactor = new ContextCompactor(model, {
    maxTokens: 10_000_000, // 固定阈值给得极大，验证 window 路径优先
    keepRecent: 2,
    contextWindowTokens: 100,
  });
  const result = await compactor.compact(longMessages(6));
  assert.strictEqual(result.compacted, true);
});
