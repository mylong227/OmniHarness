/**
 * Anthropic 滚动缓存断点规划器的语义测试。
 *
 * 覆盖的是**位置决策**（而不是「有没有这个字段」）：断点数量上限、优先级
 * （system 与最近轮优先）、极短会话不多打、非文本块不被当选、以及
 * 「第 N 轮发出的消息在第 N+1 轮逐字不变」这一**前缀稳定性**前提。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnthropicModel } from '../../src/adapters/model/anthropicModel.js';
import {
  ANTHROPIC_MAX_CACHE_BREAKPOINTS,
  AnthropicCacheBreakpoints,
  type AnthropicWireBlock,
  type AnthropicWireMessage,
} from '../../src/adapters/model/anthropicCacheBreakpoints.js';
import type { ModelRequest } from '../../src/ports/model/model.js';

const planner = new AnthropicCacheBreakpoints();

/** 断言用空消息占位（避免 `?? {…}` 处重复写字面量）。 */
const EMPTY_MESSAGE: AnthropicWireMessage = { role: 'user', content: '' };

/** 取消息数组里挂了 cache_control 的下标（升序）。 */
function breakpointIndices(messages: readonly AnthropicWireMessage[]): number[] {
  const hits: number[] = [];
  messages.forEach((message, index) => {
    if (hasCacheControl(message.content)) hits.push(index);
  });
  return hits;
}

/** content 是否含 cache_control（字符串内容恒为 false）。 */
function hasCacheControl(content: string | readonly AnthropicWireBlock[]): boolean {
  if (typeof content === 'string') return false;
  return content.some((block) => block['cache_control'] !== undefined);
}

/** 构造 user 消息（内容为数组时原样透传，用于验证非文本块行为）。 */
function user(content: string | AnthropicWireBlock[]): AnthropicWireMessage {
  return { role: 'user', content };
}

/** 构造 assistant 消息。 */
function assistant(text: string): AnthropicWireMessage {
  return { role: 'assistant', content: text };
}

/** 构造一段「user/assistant 交替」的历史（n 个完整轮次）。 */
function turns(n: number): AnthropicWireMessage[] {
  const messages: AnthropicWireMessage[] = [];
  for (let i = 0; i < n; i += 1) {
    messages.push(user(`第 ${i} 轮提问`));
    messages.push(assistant(`第 ${i} 轮回答`));
  }
  return messages;
}

/** 统计请求体里全部 cache_control 出现次数（含 system 段）。 */
function countAllBreakpoints(body: Record<string, unknown>): number {
  const system = body['system'];
  const systemCount = Array.isArray(system)
    ? system.filter((block) => (block as AnthropicWireBlock)['cache_control'] !== undefined).length
    : 0;
  return systemCount + breakpointIndices(body['messages'] as AnthropicWireMessage[]).length;
}

test('断点规划：只有 1 条 user 消息时不打消息断点（首轮无可复用前缀，不白占额度）', () => {
  assert.strictEqual(ANTHROPIC_MAX_CACHE_BREAKPOINTS, 4, 'Anthropic 的单请求断点上限');
  const plan = planner.plan([user('你好')], false);
  assert.strictEqual(plan.messageBreakpoints, 0);
  assert.deepStrictEqual(breakpointIndices(plan.messages), []);
  // 消息对象保持原引用，不做无谓复制。
  assert.strictEqual(plan.messages[0]?.content, '你好');
});

test('断点规划：2 条 user 消息（仅一个已完成轮次）时断点落在第 1 条 user 上，最新那条不动', () => {
  const messages = [user('第一轮'), assistant('回一'), user('最新提问')];
  const plan = planner.plan(messages, true);
  assert.strictEqual(plan.messageBreakpoints, 1);
  // 断点只能在「上一轮原样发出过」的消息上：最新一条本轮才首次成形，缓存它没有可复用字节。
  assert.deepStrictEqual(breakpointIndices(plan.messages), [0]);
  assert.deepStrictEqual(plan.messages[0], {
    role: 'user',
    content: [{ type: 'text', text: '第一轮', cache_control: { type: 'ephemeral' } }],
  });
  // 最新一条保持原字符串形态（不改写 ⇒ 与上一轮的字节一致）。
  assert.strictEqual(plan.messages[2]?.content, '最新提问');
  // 未当选的消息保持原引用（不复制）。
  assert.strictEqual(plan.messages[1], messages[1]);
});

test('断点规划：上限 4——system 占 1 个名额，超长历史只保留最近 3 个已完成轮次', () => {
  const messages = turns(6);
  const plan = planner.plan(messages, true);
  assert.strictEqual(plan.messageBreakpoints, 3);
  assert.strictEqual(plan.systemBreakpoint, true);
  assert.strictEqual(plan.messageBreakpoints + (plan.systemBreakpoint ? 1 : 0), 4);
  // 6 个候选（下标 0/2/4/6/8/10）去掉最新那条后，保留最近的 3 个已完成轮次：4 / 6 / 8。
  assert.deepStrictEqual(breakpointIndices(plan.messages), [4, 6, 8]);
  // 更早的轮次（更老的断点）被裁剪掉，且最新那条永不被改写。
  assert.strictEqual(hasCacheControl(plan.messages[0]?.content ?? ''), false);
  assert.strictEqual(plan.messages[10]?.['content'], '第 5 轮提问');
});

test('断点规划：无 system 时可用满 4 个名额（5 条已完成轮次里取最近 4 条）', () => {
  const messages = turns(6);
  const plan = planner.plan(messages, false);
  assert.strictEqual(plan.messageBreakpoints, ANTHROPIC_MAX_CACHE_BREAKPOINTS);
  assert.strictEqual(plan.systemBreakpoint, false);
  // 6 个候选去掉最新一条 = 5 个已完成（下标 0/2/4/6/8），只保留最近 4 个。
  assert.deepStrictEqual(breakpointIndices(plan.messages), [2, 4, 6, 8]);
});

test('断点规划：只认非空 text block——纯图片 user 不当选，锚点取最后一个文本块', () => {
  const imageOnly = user([{ type: 'image', source: { type: 'base64', data: 'x' } }]);
  const mixed = user([
    { type: 'image', source: { type: 'base64', data: 'y' } },
    { type: 'text', text: '看图' },
    { type: 'text', text: '补充说明' },
    { type: 'image', source: { type: 'base64', data: 'z' } },
  ]);
  // 候选 = [第 1 条(0), mixed(2)]（imageOnly 无文本块被跳过）；最新一条 mixed 不当选 ⇒ 只剩 0。
  const plan = planner.plan([user('第一轮'), imageOnly, mixed], false);
  assert.deepStrictEqual(breakpointIndices(plan.messages), [0]);
  assert.strictEqual(hasCacheControl(plan.messages[1]?.content ?? ''), false);

  // 再加一轮：mixed 变成「已完成」消息，锚点落在它的最后一个文本块（下标 2）。
  const later = planner.plan([user('第一轮'), imageOnly, mixed, user('第四轮')], false);
  assert.deepStrictEqual(breakpointIndices(later.messages), [0, 2]);
  const blocks = later.messages[2]?.content as AnthropicWireBlock[];
  assert.strictEqual(blocks[2]?.['cache_control'] !== undefined, true);
  assert.strictEqual(blocks[1]?.['cache_control'], undefined);
  assert.deepStrictEqual(blocks[3], { type: 'image', source: { type: 'base64', data: 'z' } });
});

test('断点规划：空文本块不被当选（不生成挂在空内容上的非法结构）', () => {
  const empty = user([{ type: 'text', text: '' }]);
  // 只有一条候选（第 1 条）且它是最新那条 ⇒ 不打断点；空块消息永远不进候选。
  const plan = planner.plan([user('第一轮'), empty], false);
  assert.deepStrictEqual(breakpointIndices(plan.messages), []);
  // 全是空块的会话同样零断点。
  const none = planner.plan([empty, user('最新')], false);
  assert.deepStrictEqual(breakpointIndices(none.messages), []);
});

test('前缀稳定性：消息顺序不变、历史内容不被改写，最新一条永不被打断点', () => {
  const round2 = [user('开头'), assistant('回一'), user('追加')];
  const plan = planner.plan(round2, true);
  assert.deepStrictEqual(
    plan.messages.map((message) => message.role),
    ['user', 'assistant', 'user'],
    '绝不重排消息顺序（重排等于清空缓存）',
  );
  assert.deepStrictEqual(
    plan.messages.map((message) => contentText(message)),
    ['开头', '回一', '追加'],
    '内容文本逐字不变（只在锚点 block 上追加 cache_control）',
  );
  assert.strictEqual(plan.messages[2]?.['content'], '追加', '最新一条保持原始形态');
});

test('前缀稳定性：已发送过的历史消息文本逐字不变，消息序列只追加（不重排）', () => {
  const p1 = planner.plan([user('u0'), assistant('a0')], true);
  const p2 = planner.plan([user('u0'), assistant('a0'), user('u1'), assistant('a1')], true);
  const p3 = planner.plan(
    [user('u0'), assistant('a0'), user('u1'), assistant('a1'), user('u2'), assistant('a2')],
    true,
  );
  // 第 1 轮已发送的那条 user 消息，在第 2/3 轮里文本逐字相同。
  assert.strictEqual(contentText(p2.messages[0] ?? EMPTY_MESSAGE), 'u0');
  assert.strictEqual(contentText(p3.messages[0] ?? EMPTY_MESSAGE), 'u0');
  // 消息序列只追加：前一轮的文本序列依次是后一轮的前缀。
  for (const [prev, next] of [
    [p1, p2],
    [p2, p3],
  ] as const) {
    assert.deepStrictEqual(
      next.messages.slice(0, prev.messages.length).map((message) => contentText(message)),
      prev.messages.map((message) => contentText(message)),
      '文本逐字保留，只有断点标记在动',
    );
    assert.deepStrictEqual(
      next.messages.map((message) => message.role).slice(0, prev.messages.length),
      prev.messages.map((message) => message.role),
      '角色序列不得重排',
    );
  }
  // 断点随轮次**前移**（滚动窗口），而不是钉死在最老一轮。
  assert.deepStrictEqual(breakpointIndices(p2.messages), [0]);
  assert.deepStrictEqual(breakpointIndices(p3.messages), [0, 2]);
});

test('前缀稳定性：断点位置随轮次单调前移，且任何时刻都不改写最新那条消息', () => {
  const rounds: AnthropicWireMessage[][] = [];
  for (let n = 1; n <= 8; n += 1) {
    const messages: AnthropicWireMessage[] = [];
    for (let i = 0; i < n; i += 1) {
      messages.push(user(`u${i}`));
      messages.push(assistant(`a${i}`));
    }
    rounds.push(messages);
  }
  let previousLast = -1;
  for (let i = 0; i < rounds.length; i += 1) {
    const plan = planner.plan(rounds[i] ?? [], true);
    const indices = breakpointIndices(plan.messages);
    // 上限恒成立（system 1 + 消息侧 ≤3）。
    assert.ok(indices.length + 1 <= ANTHROPIC_MAX_CACHE_BREAKPOINTS, `第 ${i} 轮断点超上限`);
    // 最新那条 user 消息永不被改写（它的字节本轮才首次成形）。
    const newest = plan.messages[plan.messages.length - 1];
    assert.strictEqual(typeof newest?.['content'], 'string', `第 ${i} 轮改写了最新消息`);
    // 断点位置单调前移（永不后退）。
    const last = indices.at(-1) ?? -1;
    assert.ok(last >= previousLast, `第 ${i} 轮断点后退了：${last} < ${previousLast}`);
    previousLast = last;
    // 每一轮里历史消息的文本都不被改写。
    for (const message of plan.messages) {
      assert.ok(!contentText(message).includes('cache_control'), '不得把标记写进文本');
    }
  }
});

/** 取消息的纯文本（数组内容取第一个 text block，仅用于本文件断言）。 */
function contentText(message: AnthropicWireMessage): string {
  if (typeof message.content === 'string') return message.content;
  const first = message.content.find((block) => block['type'] === 'text');
  return typeof first?.['text'] === 'string' ? first['text'] : '';
}

test('Anthropic 请求体：system 断点保留，且消息侧断点进入真实请求体', async () => {
  const model = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-test',
    model: 'claude-3-5-sonnet',
  });
  const request: ModelRequest = {
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: '收到' },
      { role: 'user', content: '第二轮' },
    ],
    tools: [],
  };
  let captured: Record<string, unknown> | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    await model.generate(request);
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(captured !== undefined, '必须捕获到请求体');
  assert.strictEqual(countAllBreakpoints(captured), 2, 'system 1 个 + 消息侧 1 个');
  assert.deepStrictEqual(captured['system'], [
    { type: 'text', text: '你是助手', cache_control: { type: 'ephemeral' } },
  ]);
  const messages = captured['messages'] as AnthropicWireMessage[];
  // 断点落在「第一轮」这条已发送过的 user 消息上，最新那条（第二轮）保持原样。
  assert.deepStrictEqual(breakpointIndices(messages), [0]);
  assert.strictEqual(messages[messages.length - 1]?.['content'], '第二轮');
});

test('Anthropic 请求体：无 system 时不出 system 字段，且断点总数仍 ≤4', async () => {
  const model = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-test',
    model: 'claude-3-5-sonnet',
  });
  const request: ModelRequest = {
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
      { role: 'assistant', content: 'f' },
      { role: 'user', content: 'g' },
    ],
    tools: [],
  };
  let captured: Record<string, unknown> | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    await model.generate(request);
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(captured !== undefined);
  assert.strictEqual(captured['system'], undefined);
  // 4 个候选（user 在下标 0/2/4/6）去掉最新那条 = 3 个已完成轮次 ⇒ 消息侧 3 个断点。
  assert.strictEqual(countAllBreakpoints(captured), 3);
  assert.ok(countAllBreakpoints(captured) <= ANTHROPIC_MAX_CACHE_BREAKPOINTS);
  assert.deepStrictEqual(
    breakpointIndices(captured['messages'] as AnthropicWireMessage[]),
    [0, 2, 4],
  );
});
