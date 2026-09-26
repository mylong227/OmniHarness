/**
 * P_prefix **wire 层**验收（Responses 协议）：适配器不得把动态 system 段（repo-map）搬进顶层
 * `instructions` 字段——否则前缀缓存被逐轮击穿。
 *
 * 与 `anthropicWirePrefix.test.ts` 同源、同断言：`StepContextBuilder` 已把逐步变化的 repo-map
 * 置于消息数组**尾部**（P_prefix 治理），而 `ResponsesModel` 旧实现用
 * `messages.filter(role === 'system')` 把**所有** system 抽进 `instructions`——`instructions`
 * 排在所有 `input` 之前，于是尾段被搬回最前，其后整段事件历史每步重新计费。
 *
 * 断言（可证伪）：
 *  1. 连续两步请求的 `instructions` 必须**逐字节相同**；
 *  2. 第 N 步的 input 会话消息（去尾段）必须是第 N+1 步 `input` 的**逐元素前缀**；
 *  3. 整请求体归一化后的前缀复用率 ≥ 0.8（修复前实测 ~20% 量级）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ResponsesModel } from '../../src/adapters/model/responsesModel.js';
import { PrefixStability } from '../../src/context/prefixStability.js';
import type { ModelMessage, ModelRequest } from '../../src/ports/model/model.js';

/** 固定系统片段（短：模拟 `world_state`）。 */
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
    { role: 'system', content: dynamicSegment },
  ];
}

const model = new ResponsesModel({
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-5',
  store: false,
});

/** 捕获一次真实请求的 wire 请求体（fetch 被临时接管，结束即还原）。 */
async function captureWireBody(request: ModelRequest): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: 'resp_1', output: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    await model.generate(request);
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(captured !== undefined, '必须捕获到请求体');
  return captured;
}

const DYNAMIC_1 = '## repo-map（第 1 步）\n- src/parser.ts\n- src/lexer.ts';
const DYNAMIC_2 = '## repo-map（第 2 步）\n- src/parser.ts\n- src/lexer.ts\n- src/ast.ts';

/** 第二步相对第一步新增的历史（模拟新一轮 user/assistant 往返）。 */
const NEXT_TURN: readonly ModelMessage[] = [
  { role: 'user', content: '继续：再修 src/ast.ts。' },
  { role: 'assistant', content: '好。' },
];

test('P_prefix(responses)：动态段不得进入 instructions —— 两步 instructions 必须逐字节相同', async () => {
  const body1 = await captureWireBody({ messages: stepMessages(DYNAMIC_1, []), tools: [] });
  const body2 = await captureWireBody({ messages: stepMessages(DYNAMIC_2, NEXT_TURN), tools: [] });

  const instructions1 = body1['instructions'];
  const instructions2 = body2['instructions'];
  assert.strictEqual(typeof instructions1, 'string', '应有 instructions 字段');
  assert.strictEqual(
    instructions1,
    instructions2,
    'instructions 必须是跨步稳定的前缀锚点；若它含逐步变化的 repo-map，其后整段 input 每步都重新计费',
  );
  const text = String(instructions1);
  assert.ok(text.includes(FIXED.slice(0, 10)), '固定系统片段仍应在 instructions 中');
  assert.ok(text.includes('AGENTS.md'), '常驻指令仍应在 instructions 中');
  assert.ok(!text.includes('repo-map'), '动态 repo-map 不得出现在 instructions 中');
});

test('P_prefix(responses)：动态段留在原位（input 尾部）且内容不丢', async () => {
  const body = await captureWireBody({ messages: stepMessages(DYNAMIC_1, []), tools: [] });
  const input = body['input'] as { role: string; content: string }[];
  assert.ok(Array.isArray(input), 'input 应为数组');
  const last = input[input.length - 1];
  assert.ok(last !== undefined, 'input 不应为空');
  assert.strictEqual(last.role, 'system', '尾部动态段保留 system 角色（Responses input 允许）');
  assert.ok(last.content.includes('repo-map'), '尾部动态段内容必须原样保留，零信息损失');
});

test('P_prefix(responses)：第 N 步 input（去尾段）是第 N+1 步 input 的逐元素前缀', async () => {
  const body1 = await captureWireBody({ messages: stepMessages(DYNAMIC_1, []), tools: [] });
  const body2 = await captureWireBody({ messages: stepMessages(DYNAMIC_2, NEXT_TURN), tools: [] });
  const input1 = body1['input'] as unknown[];
  const input2 = body2['input'] as unknown[];
  assert.ok(input1.length >= 2 && input2.length > input1.length, '两步 input 数应递增');
  const stableHead = input1.slice(0, -1);
  assert.deepStrictEqual(
    input2.slice(0, stableHead.length),
    stableHead,
    '事件历史必须构成可复用的前缀（同一内容、同一位置）',
  );
});

/**
 * 把请求体投影成**上游实际看到的提示顺序**：`instructions` 在前、`input` 在后。
 *
 * 为什么不能直接 `JSON.stringify(body)`：本适配器把 `instructions` 写在 `input` **之后**
 * （见 `bodyOf` 的字段追加顺序），而 Responses API 在服务端是「instructions 拼在 input 之前」。
 * 按 JSON 字节序度量会把 instructions 的分歧错算到 input 之后，从而**漏掉**本文件要抓的缺陷。
 */
function promptView(body: Record<string, unknown>): string {
  return `${String(body['instructions'] ?? '')}\n--input--\n${JSON.stringify(body['input'] ?? [])}`;
}

test('P_prefix(responses)：整请求前缀复用率 ≥ 0.8', async () => {
  const body1 = await captureWireBody({ messages: stepMessages(DYNAMIC_1, []), tools: [] });
  const body2 = await captureWireBody({ messages: stepMessages(DYNAMIC_2, NEXT_TURN), tools: [] });
  const reuse = PrefixStability.prefixReuse(promptView(body1), promptView(body2));
  assert.ok(
    reuse >= 0.8,
    `前缀复用率应 ≥ 0.8（实测 ${(reuse * 100).toFixed(1)}%）；若动态段被搬进 instructions，该值会塌到 ~20%`,
  );
});
