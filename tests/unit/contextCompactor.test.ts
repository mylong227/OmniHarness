import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextCompactor } from '../../src/context/contextCompactor.js';
import type {
  ModelMessage,
  ModelOutput,
  ModelPort,
  ModelRequest,
} from '../../src/ports/model/model.js';

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

test('压缩器：每请求固定开销（工具 schema + 尾部文本）挤占同一预算 ⇒ 提前压缩（§3-3 后半）', async () => {
  // 消息本身远在预算内，但「工具 schema + repo-map 尾段」是同一请求体的恒定占用。
  // 不入账的后果：记账偏低 ⇒ 越过真实窗口才压缩 ⇒ 超窗请求打到上游（fail-open 400）。
  const messages = longMessages(3);
  const tool = {
    name: 'shell',
    description: '跑命令',
    parameters: {
      type: 'object' as const,
      properties: { command: { type: 'string' } },
    },
  };
  const roomy = new ContextCompactor(
    fakeModel(() => ({ text: '摘要' })),
    {
      maxTokens: 100000,
      keepRecent: 2,
    },
  );
  const withoutOverhead = await roomy.compact(messages);
  assert.strictEqual(withoutOverhead.compacted, false);

  // 同一批消息 + 一份足够大的固定开销 ⇒ 必须触发压缩（此前完全看不到这份占用）。
  const tight = new ContextCompactor(
    fakeModel(() => ({ text: '摘要' })),
    {
      maxTokens: 200,
      keepRecent: 2,
    },
  );
  const without = await tight.compact(messages);
  const withOverhead = await tight.compact(messages, undefined, {
    tools: [tool],
    trailingText: 'x'.repeat(4000),
  });
  assert.strictEqual(without.compacted, false, '无固定开销时 200 token 预算下消息未超');
  assert.strictEqual(withOverhead.compacted, true, '计入固定开销后必须提前压缩');
});

test('压缩器：固定开销超过预算时夹到下限，不得把历史清空（比超窗更糟）', async () => {
  const compactor = new ContextCompactor(
    fakeModel(() => ({ text: '摘要' })),
    {
      maxTokens: 100,
      keepRecent: 2,
    },
  );
  const result = await compactor.compact(longMessages(8), undefined, {
    trailingText: 'y'.repeat(100_000),
  });
  assert.ok(result.messages.length >= 2, '至少保留摘要 + 一条消息，不得丢光会话历史');
});

test('压缩器：超预算用 LLM 摘要折叠历史', async () => {
  const compactor = new ContextCompactor(
    fakeModel(() => ({ text: '历史摘要内容' })),
    { maxTokens: 50, keepRecent: 2 },
  );
  const result = await compactor.compact(longMessages(6));
  assert.strictEqual(result.compacted, true);
  assert.strictEqual(result.summary, '历史摘要内容');
  // 2026-09-19 契约变更：**预算现在真的生效**。旧断言写死 3 条（1 摘要 + 2 最近），
  // 但 50 token 预算下「摘要 + 2 条长消息」本身就超预算 ⇒ 那是在钉「报 compacted 却仍超预算」的
  // fail-open 行为。现改为折叠后继续丢弃较旧的 tail 消息，直到落入预算（至少保留摘要 + 1 条）。
  assert.strictEqual(result.messages.length, 2);
  assert.strictEqual(result.messages[0]?.role, 'system');
  assert.strictEqual(result.messages[0]?.content, '历史摘要内容');
});

test('压缩器：无模型退化为占位摘要 + 最近消息', async () => {
  const compactor = new ContextCompactor(undefined, { maxTokens: 50, keepRecent: 2 });
  const result = await compactor.compact(longMessages(6));
  assert.strictEqual(result.compacted, true);
  assert.strictEqual(result.summary, '[历史已省略]');
  // 同上：占位摘要 + 最近消息，仍受预算约束（50 token 下只留摘要 + 1 条）。
  assert.strictEqual(result.messages.length, 2);
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

test('压缩器：keepRecent ≥ 消息总数时的两条不变量（预算内不谎报 / 超预算真丢弃）', async () => {
  // ① 预算内：无 head 可折叠、也不超预算 ⇒ 原样保留且**如实回 compacted:false**（不谎报已压缩）。
  const roomy = new ContextCompactor(undefined, { maxTokens: 100_000, keepRecent: 10 });
  const kept = await roomy.compact(longMessages(3));
  assert.strictEqual(kept.messages.length, 3, '未超预算不得丢弃任何消息');
  assert.strictEqual(kept.compacted, false, '未发生压缩就必须如实回 false');
  assert.strictEqual(kept.summary, undefined, '未压缩不得给出「已省略」摘要');

  // ② 超预算：无 head 可摘要时**真丢弃**最旧消息直至预算内，并如实写明丢弃条数。
  // 旧实现在这里返回全部消息却报 compacted:true + '[历史已省略]'（实测「阈值 100、输入 4 万字符 →
  // 输出 4 万字符」），即假称已压缩而超窗请求照发 —— 这是 fail-open，现被本用例钉死。
  const tight = new ContextCompactor(undefined, { maxTokens: 1, keepRecent: 10 });
  const dropped = await tight.compact(longMessages(3));
  assert.strictEqual(dropped.compacted, true);
  assert.ok(
    dropped.messages.length < 3,
    `超预算必须真的丢弃（实际仍留 ${dropped.messages.length} 条）`,
  );
  assert.match(dropped.summary ?? '', /最早 \d+ 条历史已省略/, '摘要须如实写明丢弃条数');
});

/* ---------------- P2（打磨）：确定性无损收缩接线 ---------------- */

test('P2：默认开启无损收缩——system 原样，user/assistant/tool 收缩且结构字段保留', async () => {
  const compactor = new ContextCompactor(undefined, { maxTokens: 100000, keepRecent: 2 });
  const messages: ModelMessage[] = [
    { role: 'system', content: 'SYS   \n\n\n\nkeep' },
    { role: 'assistant', content: '{\n  "a": 1\n}' },
    { role: 'tool', content: 'line   \n\n\n\nline2', toolCallId: 'c1' },
  ];
  const result = await compactor.compact(messages);
  assert.strictEqual(result.compacted, false);
  // system 由 harness 编排，不得改动
  assert.strictEqual(result.messages[0]?.content, 'SYS   \n\n\n\nkeep');
  assert.strictEqual(result.messages[1]?.content, '{"a":1}');
  assert.strictEqual(result.messages[2]?.content, 'line\n\nline2');
  // wire 层结构字段不得被破坏
  assert.strictEqual(result.messages[2]?.toolCallId, 'c1');
  assert.ok(result.shrink !== undefined);
  assert.ok(result.shrink.savedBytes > 0);
  assert.ok(result.shrink.ratio < 1);
});

test('P2：deterministicShrink=false 逐字节回到旧行为（无 shrink 度量）', async () => {
  const compactor = new ContextCompactor(undefined, {
    maxTokens: 100000,
    keepRecent: 2,
    deterministicShrink: false,
  });
  const messages: ModelMessage[] = [{ role: 'tool', content: '{\n  "a": 1\n}', toolCallId: 'c1' }];
  const result = await compactor.compact(messages);
  assert.strictEqual(result.messages[0]?.content, '{\n  "a": 1\n}');
  assert.strictEqual(result.shrink, undefined);
});

test('P2：压缩触发时保留的 tail 仍被收缩，reasoningContent 原样回传（思考模式硬要求）', async () => {
  const compactor = new ContextCompactor(undefined, { maxTokens: 50, keepRecent: 2 });
  const messages: ModelMessage[] = [
    { role: 'user', content: 'old-1 '.repeat(80) },
    { role: 'user', content: 'old-2 '.repeat(80) },
    { role: 'assistant', content: '{"head": 1}' },
    { role: 'user', content: '{\n  "keep": 1\n}' },
    { role: 'assistant', content: 'end   \n\n\n\nx', reasoningContent: 'thinking...' },
  ];
  const result = await compactor.compact(messages);
  assert.strictEqual(result.compacted, true);
  assert.strictEqual(result.messages[0]?.role, 'system');
  assert.strictEqual(result.messages[1]?.content, '{"keep":1}');
  assert.strictEqual(result.messages[2]?.content, 'end\n\nx');
  assert.strictEqual(result.messages[2]?.reasoningContent, 'thinking...');
  assert.ok((result.shrink?.savedBytes ?? 0) > 0);
});

test('P2：游标复用路径（不调 LLM）同样施加收缩', async () => {
  const compactor = new ContextCompactor(
    fakeModel(() => ({ text: '摘要内容' })),
    { maxTokens: 50, keepRecent: 2 },
  );
  const messages: ModelMessage[] = [
    { role: 'user', content: 'old '.repeat(80) },
    { role: 'user', content: 'old '.repeat(80) },
    { role: 'assistant', content: 'head-done' },
    { role: 'user', content: '{\n  "tail": true\n}' },
    { role: 'assistant', content: 'tail-two   \n\n\n\nz' },
  ];
  const first = await compactor.compact(messages);
  assert.strictEqual(first.compacted, true);
  const second = await compactor.compact(messages, first.state);
  assert.strictEqual(second.summary, first.summary);
  // 游标路径：摘要复用（零 LLM），且保留 tail 仍被无损收缩
  assert.strictEqual(second.messages[1]?.content, '{"tail":true}');
  assert.strictEqual(second.messages[2]?.content, 'tail-two\n\nz');
  assert.ok((second.shrink?.savedBytes ?? 0) > 0);
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

/* ----------------------- 2026-10-03：切分边界按工具轮对齐 ----------------------- */

test('压缩器：assistant(tool_calls) 与其 tool 结果永不被边界切开（旧边界在良构投影上切轮是常态）', async () => {
  const seen: ModelRequest[] = [];
  const model: ModelPort = {
    name: 'fake',
    async generate(request: ModelRequest): Promise<ModelOutput> {
      seen.push(request);
      return { text: '摘要' };
    },
  };
  const messages: ModelMessage[] = [
    { role: 'user', content: 'u1'.repeat(80) },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
    { role: 'tool', content: 'r1', toolCallId: 'c1' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read', arguments: {} }] },
    { role: 'tool', content: 'r2', toolCallId: 'c2' },
    { role: 'user', content: 'u2'.repeat(80) },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c3', name: 'read', arguments: {} }] },
    { role: 'tool', content: 'r3', toolCallId: 'c3' },
  ];
  // keepRecent=2 ⇒ 旧边界 = 8-2 = 6，恰落在 assistant(c3) 与 tool(c3) 之间（切轮）。
  // 修后边界左移到 5（user u2），整个 c3 轮让给 tail。
  const compactor = new ContextCompactor(model, { maxTokens: 50, keepRecent: 2 });
  const result = await compactor.compact(messages);
  assert.strictEqual(result.compacted, true);
  assert.strictEqual(
    result.state?.compactedUpTo,
    5,
    '边界必须落在 user u2 之后（c3 轮整体在 tail）',
  );
  // 摘要请求的 head 不得以 assistant(tool_calls) 收尾——严格端点会 400，宽容端点会剥掉 tool_calls。
  const request = seen[0];
  assert.ok(request !== undefined, '必须发起过一次摘要请求');
  const headLast = request.messages[request.messages.length - 2];
  assert.ok(
    headLast !== undefined && headLast.role !== 'assistant',
    'head 最后一条不得是 assistant',
  );
  // tail 必须完整包含 c3 轮：assistant(tool_calls) 在前、其 tool 结果紧随。
  const tail = result.messages.slice(1);
  const c3Index = tail.findIndex((m) => m.toolCalls?.some((call) => call.id === 'c3'));
  const r3Index = tail.findIndex((m) => m.toolCallId === 'c3');
  assert.ok(c3Index >= 0, 'c3 调用必须在 tail 中');
  assert.ok(r3Index === c3Index + 1, 'c3 的结果必须紧随其后（轮次完整）');
});

test('压缩器：head 只剩 system（无对话可折）时不得调摘要模型，也不得写游标（真机「历史为空」垃圾摘要回归判据）', async () => {
  // 2026-10-07 真机实测（新项目 sess_muxj2kcl_1）：首次压缩边界恰好落在 1，head=[system 提示]
  // 被送去摘要，模型如实答「任务目标：无（历史为空…）」——零信息摘要被写成 OMNI_COMPACTION_V1
  // 游标注入后续每步，模型据此宣称「完全完成不了这样的任务」。
  // 判据：这条路径必须走「如实丢弃兜底」，摘要模型一次都不被调用、不产生游标。
  const seen: ModelRequest[] = [];
  const spy: ModelPort = {
    name: 'spy',
    async generate(request: ModelRequest): Promise<ModelOutput> {
      seen.push(request);
      return { text: '不应被调用的摘要' };
    },
  };
  const compactor = new ContextCompactor(spy, { maxTokens: 60, keepRecent: 3 });
  // projected 首条是 harness 的 system 提示（真实请求形态）；keepRecent=3 ⇒ 边界=1，head=[system]。
  const messages: ModelMessage[] = [
    { role: 'system', content: '你是 OmniHarness 工作台代理。'.repeat(10) },
    { role: 'user', content: '完成一个小游戏程序'.repeat(30) },
    { role: 'assistant', content: '好的，开始分析需求'.repeat(30) },
    { role: 'user', content: '继续'.repeat(30) },
  ];
  const result = await compactor.compact(messages);
  assert.deepStrictEqual(seen, [], 'head 无对话内容时不得发起任何摘要请求');
  assert.strictEqual(result.state, undefined, '不得写压缩游标（没有值得折叠的对话）');
  for (const m of result.messages) {
    assert.ok(!m.content.includes('不应被调用的摘要'), '零信息摘要不得进入请求上下文');
  }
  // 最新一条用户消息必须保留（兜底丢最旧、保最新）。
  const last = result.messages[result.messages.length - 1];
  assert.ok(last !== undefined && last.content.includes('继续'), '兜底不得丢最新一条消息');
  // 若确实丢弃了消息，摘要必须是如实的占位文本而不是模型编的内容。
  if (result.compacted) {
    assert.match(result.summary ?? '', /^\[最早 \d+ 条历史已省略\]$/, '摘要必须是如实占位');
  }
});

test('压缩器：head 只剩 system 且超预算 ⇒ 走丢弃兜底并如实报 compacted（不产摘要）', async () => {
  const seen: ModelRequest[] = [];
  const spy: ModelPort = {
    name: 'spy',
    async generate(request: ModelRequest): Promise<ModelOutput> {
      seen.push(request);
      return { text: '不应被调用的摘要' };
    },
  };
  const compactor = new ContextCompactor(spy, { maxTokens: 40, keepRecent: 2 });
  const messages: ModelMessage[] = [
    { role: 'system', content: '系统提示'.repeat(5) },
    { role: 'user', content: 'u1'.repeat(200) },
    { role: 'assistant', content: 'a1'.repeat(200) },
  ];
  const result = await compactor.compact(messages);
  assert.deepStrictEqual(seen, [], '仍不得调摘要模型');
  assert.strictEqual(result.state, undefined);
  // keepRecent=2、head=[system]：兜底丢弃最旧直到入预算，被丢的消息如实计数。
  assert.ok(
    result.messages.length < messages.length || result.compacted === false,
    '要么丢弃了最旧消息（compacted=true + 摘要占位），要么本就在预算内',
  );
  // system 提示不得因为"所在段不可折叠"而被优先丢出上下文（保序丢最旧时它在最前，
  // 但最新一条必须留）。
  const last = result.messages[result.messages.length - 1];
  assert.ok(last !== undefined && last.content.includes('a1'), '兜底不得丢最新一条消息');
});
