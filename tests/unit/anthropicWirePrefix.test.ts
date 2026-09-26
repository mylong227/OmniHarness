/**
 * P_prefix **wire 层**验收：适配器不得把动态 system 段（repo-map）搬进顶层 system/instructions
 * 字段——否则前缀缓存被逐轮击穿。
 *
 * ## 为什么必须有这一层测试
 *
 * `stepContextBuilder` 已按「固定头 → 事件历史 → **动态尾段（repo-map）**」排布消息数组，
 * 并有 `stepContextBuilderPrefix.test.ts` 钉住**数组下标**。但 Anthropic Messages API 没有
 * `system` 角色：适配器 `splitSystem` 会把**所有** `role:'system'` 消息抽出来拼进顶层
 * `system` 字段。于是尾部的 repo-map 被搬回**整个提示的最前面**，而它是每一步都变的——
 * 内容前缀在 system 中途就分叉，后面整段事件历史（提示里的大头）**每步都重新计费**。
 *
 * 即：数组层的 P_prefix 治理在 wire 层被适配器静默撤销（「口径宣称 ≠ 事实」的典型形态）。
 *
 * ## 断言（可证伪）
 *
 *  1. 连续两步请求的顶层 `system` 字段必须**逐字节相同**（稳定前缀锚点）；
 *  2. 第 N 步的会话消息（去掉尾部动态段）必须是第 N+1 步 `messages` 的**逐元素前缀**；
 *  3. 整个请求体归一化后的前缀复用率 ≥ 0.8（`PrefixStability.prefixReuse`，与上游
 *     KV/prompt 缓存「只复用公共前缀」的物理事实同一口径）。
 *
 * 对照量级（同一 fixture）：修复前复用率实测 **17.2%**，修复后 ≥ 90% ⇒ 断言 3 直接区分。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnthropicModel } from '../../src/adapters/model/anthropicModel.js';
import { PrefixStability } from '../../src/context/prefixStability.js';
import type { ModelMessage, ModelRequest } from '../../src/ports/model/model.js';

/** 固定系统片段（短：模拟 `world_state`，故意让它占比小）。 */
const FIXED = '你是 OmniHarness 的 AI 助手，运行在用户工作区中。直接、高效地完成用户任务。';

/** 常驻指令（长、静态：模拟 AGENTS.md）。 */
const INSTRUCTIONS = `## AGENTS.md\n${'禁止占位符交差；改代码前先定位；改完必须自证。\n'.repeat(20)}`;

/** 会话历史：8 轮 user/assistant（提示里的大头）。 */
const HISTORY: ModelMessage[] = Array.from({ length: 8 }, (_, i) => [
  {
    role: 'user' as const,
    content: `第 ${i + 1} 轮用户请求：${'请修复 src/parser.ts 的分词缺陷。'.repeat(6)}`,
  },
  {
    role: 'assistant' as const,
    content: `第 ${i + 1} 轮助手回复：${'已定位到 tokenize 的第 42 行。'.repeat(6)}`,
  },
]).flat();

/** 构造某一步的消息序列（形状与 `StepContextBuilder.buildMessages` 产出一致）。 */
function stepMessages(
  dynamicSegment: string,
  extraHistory: readonly ModelMessage[],
): ModelMessage[] {
  return [
    { role: 'system', content: FIXED },
    { role: 'system', content: INSTRUCTIONS },
    ...HISTORY,
    ...extraHistory,
    // 动态尾段：每步都变（repo-map 随查询派生）。
    { role: 'system', content: dynamicSegment },
  ];
}

/** 捕获一次真实请求的 wire 请求体（fetch 被临时接管，结束即还原）。 */
async function captureWireBody(
  model: AnthropicModel,
  request: ModelRequest,
): Promise<Record<string, unknown>> {
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
  return captured;
}

/** 取 wire 层 system 字段的文本形态（不存在时为 undefined）。 */
function systemText(body: Record<string, unknown>): string | undefined {
  const system = body['system'];
  if (!Array.isArray(system)) return undefined;
  return system
    .map((block) => (block as { text?: unknown }).text)
    .filter((text): text is string => typeof text === 'string')
    .join('\n');
}

/**
 * 归一化为**纯内容视图**：剥掉 `cache_control` 标记，并把「字符串内容」与
 * 「单 text block 数组」两种等价编码统一成同一种形态。
 *
 * 为什么必须归一化（两条都不属于被缓存的内容）：
 *  1. `cache_control` 是**请求侧指令**（缓存边界声明），上游按内容建键；滚动断点每步前移属预期行为。
 *     若不剥离，测到的是「断点标记位移」而不是「内容前缀是否稳定」。
 *  2. 本仓 `withBreakpoint` 会把「要打断点的字符串消息」包成 `[{type:'text',text}]`。
 *     纯字符串与单 text block 是**同一段内容**的两种等价编码，token 序列完全相同；
 *     把它算作分歧，会让度量把已知无害的编码差异当成缺陷。
 *
 * 归一化后剩下的差异，才是真正会让缓存失效的东西：**提示内容的顺序/取值发生了变化**
 * （例如把逐步变化的 repo-map 搬进排在最前面的 system 字段）。
 */
function contentView(body: Record<string, unknown>): Record<string, unknown> {
  const unwrap = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const entries = value.map(unwrap);
      // 单 text block ⇄ 纯字符串：统一成纯字符串。
      if (
        entries.length === 1 &&
        entries[0] !== null &&
        typeof entries[0] === 'object' &&
        (entries[0] as { type?: unknown }).type === 'text' &&
        typeof (entries[0] as { text?: unknown }).text === 'string'
      ) {
        return (entries[0] as { text: string }).text;
      }
      return entries;
    }
    if (value === null || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'cache_control') continue;
      out[key] = unwrap(entry);
    }
    return out;
  };
  return unwrap(body) as Record<string, unknown>;
}

const model = new AnthropicModel({
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-test',
  model: 'claude-3-5-sonnet',
});

const DYNAMIC_1 = '## repo-map（第 1 步）\n- src/parser.ts\n- src/lexer.ts';
const DYNAMIC_2 = '## repo-map（第 2 步）\n- src/parser.ts\n- src/lexer.ts\n- src/ast.ts';

/** 第二步相对第一步新增的历史（模拟新一轮 user/assistant 往返）。 */
const NEXT_TURN: readonly ModelMessage[] = [
  { role: 'user', content: '继续：再修 src/ast.ts。' },
  { role: 'assistant', content: '好。' },
];

test('P_prefix(wire)：动态段不得进入顶层 system —— 两步 system 字段必须逐字节相同', async () => {
  const body1 = await captureWireBody(model, {
    messages: stepMessages(DYNAMIC_1, []),
    tools: [],
  });
  const body2 = await captureWireBody(model, {
    messages: stepMessages(DYNAMIC_2, NEXT_TURN),
    tools: [],
  });

  const system1 = systemText(body1);
  const system2 = systemText(body2);
  assert.ok(system1 !== undefined && system2 !== undefined, '两步都应有 system 字段');
  assert.strictEqual(
    system1,
    system2,
    '顶层 system 必须是**跨步逐字节稳定**的锚点；若它含逐步变化的 repo-map，其后整段历史每步都重新计费',
  );
  assert.ok(system1.includes(FIXED.slice(0, 10)), '固定系统片段仍应留在顶层 system 中');
  assert.ok(system1.includes('AGENTS.md'), '常驻指令仍应留在顶层 system 中');
  assert.ok(!system1.includes('repo-map'), '动态 repo-map 不得出现在顶层 system 中');
});

test('P_prefix(wire)：第 N 步会话消息（去尾段）是第 N+1 步 messages 的逐元素前缀', async () => {
  const body1 = contentView(
    await captureWireBody(model, { messages: stepMessages(DYNAMIC_1, []), tools: [] }),
  );
  const body2 = contentView(
    await captureWireBody(model, { messages: stepMessages(DYNAMIC_2, NEXT_TURN), tools: [] }),
  );

  const messages1 = body1['messages'] as unknown[];
  const messages2 = body2['messages'] as unknown[];
  assert.ok(messages1.length >= 2 && messages2.length > messages1.length, '两步消息数应递增');
  // 去掉第 1 步的尾部动态段后，余下部分（整段事件历史）应逐元素出现在第 2 步的同一位置。
  const stableHead = messages1.slice(0, -1);
  assert.deepStrictEqual(
    messages2.slice(0, stableHead.length),
    stableHead,
    '事件历史必须构成可复用的前缀（同一内容、同一位置）',
  );
});

test('P_prefix(wire)：整请求前缀复用率 ≥ 0.8（上游缓存只复用公共前缀）', async () => {
  const body1 = contentView(
    await captureWireBody(model, { messages: stepMessages(DYNAMIC_1, []), tools: [] }),
  );
  const body2 = contentView(
    await captureWireBody(model, { messages: stepMessages(DYNAMIC_2, NEXT_TURN), tools: [] }),
  );

  const serialized1 = JSON.stringify(body1);
  const serialized2 = JSON.stringify(body2);
  const reuse = PrefixStability.prefixReuse(serialized1, serialized2);
  assert.ok(
    reuse >= 0.8,
    `前缀复用率应 ≥ 0.8（实测 ${(reuse * 100).toFixed(1)}%）；若动态段被搬进 system，该值会塌到 ~20%`,
  );
});
