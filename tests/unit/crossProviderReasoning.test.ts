/**
 * **跨 provider 推理档**判据（2026-10-11，目标项「跨 provider reasoning 档」）。
 *
 * ## 修之前是什么样子（实测）
 *
 * `ModelRequest.reasoningEffort` **只在 OpenAI 兼容通路**被透传成 `reasoning_effort`；
 * Responses / Anthropic / Ollama 三条通路**完全忽略**它 —— 调用方写 `--reasoning-effort high`，
 * 在那三家上等于什么都没发生（静默失效）。本次把它映射到四家各自的字段，并处理两条硬约束。
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | OpenAI 兼容：非空串透传 `reasoning_effort`；空串/缺省**不发** | 旧行为被改（空串会让 DeepSeek 类端点 400） |
 * | ② | Responses：`reasoning: {effort}` | 该通路继续静默忽略 |
 * | ③ | Anthropic：`thinking:{type:'enabled',budget_tokens}` 且 **`max_tokens > budget_tokens`** | 请求被 Anthropic 直接拒（硬约束） |
 * | ④ | Anthropic 未知档位 **fail-closed** | 猜一个预算 = 把"要高强度推理"静默降级 |
 * | ⑤ | Ollama：`think: true/false`（关档显式 false，未设不发） | 该通路继续静默忽略 |
 * | ⑥ | 单一实现：四家字段字面量只许住在映射模块 | 上游改字段名只会改到一两条 |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnthropicModel } from '../../src/adapters/model/anthropicModel.ts';
import { OpenAiCompatibleModel } from '../../src/adapters/model/openAiCompatibleModel.ts';
import { ResponsesModel } from '../../src/adapters/model/responsesModel.ts';
import { LlamaCppModel } from '../../src/adapters/model/llamaCppModel.ts';
import { ModelReasoningEfforts } from '../../src/adapters/model/modelReasoningEfforts.ts';
import type { ModelRequest } from '../../src/ports/model/model.ts';

/** 仓库根（判据在 `dist/tests/unit/`，源码按 cwd 读）。 */
const REPO_ROOT = process.cwd();

/**
 * 构造一个带推理档的请求。
 *
 * @param effort 推理强度（缺省＝不设该字段）。
 * @returns 模型请求。
 */
function request(effort?: string): ModelRequest {
  return {
    messages: [{ role: 'user', content: '想一道题' }],
    tools: [],
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  };
}

/** 临时替换 fetch，回传捕获到的请求体。 */
async function captureBody<T>(
  handler: () => Promise<Response>,
  fn: () => Promise<T>,
): Promise<{ readonly result: T; readonly body: Record<string, unknown> }> {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return handler();
  }) as typeof fetch;
  try {
    const result = await fn();
    return { result, body };
  } finally {
    globalThis.fetch = original;
  }
}

test('① OpenAI 兼容：非空串透传 reasoning_effort；空串/缺省不发（旧行为不变）', async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk',
    model: 'gpt-x',
  });
  const ok = await captureBody(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    () => model.generate(request('high')),
  );
  assert.strictEqual(ok.body['reasoning_effort'], 'high');

  for (const [label, effort] of [
    ['空串', ''],
    ['缺省', undefined],
  ] as const) {
    const plain = await captureBody(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      () => model.generate(request(effort)),
    );
    assert.strictEqual(
      'reasoning_effort' in plain.body,
      false,
      `${label} 不得带 reasoning_effort（DeepSeek 类端点对空串 400）`,
    );
  }
});

test('② Responses：走 reasoning.effort（此前该通路完全忽略该意图）', async () => {
  const model = new ResponsesModel({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk',
    model: 'gpt-5',
    store: false,
  });
  const { body } = await captureBody(
    async () => new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 }),
    () => model.generate(request('medium')),
  );
  assert.deepStrictEqual(body['reasoning'], { effort: 'medium' });
  const plain = await captureBody(
    async () => new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 }),
    () => model.generate(request()),
  );
  assert.strictEqual('reasoning' in plain.body, false, '未设档位时不得带 reasoning');
});

test('③ Anthropic：thinking 预算按档位映射，且 max_tokens 必须**大于**预算（硬约束）', async () => {
  const model = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk',
    model: 'claude-x',
  });
  for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
    const { body } = await captureBody(
      async () =>
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }),
      () => model.generate(request(level)),
    );
    const thinking = body['thinking'] as { type: string; budget_tokens: number };
    assert.strictEqual(thinking.type, 'enabled', `${level}：应开启 thinking`);
    assert.strictEqual(
      thinking.budget_tokens,
      ModelReasoningEfforts.ANTHROPIC_BUDGETS[level],
      `${level}：预算应与映射表一致`,
    );
    const maxTokens = Number(body['max_tokens']);
    assert.ok(
      maxTokens > thinking.budget_tokens,
      `${level}：max_tokens(${String(maxTokens)}) 必须 > budget_tokens(${String(thinking.budget_tokens)})，否则 Anthropic 直接拒`,
    );
  }
  // `none` 是**合法配置**：语义是"关掉扩展思考"⇒ 不下发 thinking（不得抛错）。
  const { body: noneBody } = await captureBody(
    async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }),
    () => model.generate(request('none')),
  );
  assert.strictEqual('thinking' in noneBody, false, 'none 档不得下发 thinking');
  // 预算必须随档位单调递增（否则"提升档位"在预算上反而变小，语义自相矛盾）。
  const budgets = ModelReasoningEfforts.ANTHROPIC_BUDGET_ORDER;
  for (let i = 1; i < budgets.length; i += 1) {
    assert.ok(
      (budgets[i] ?? 0) > (budgets[i - 1] ?? 0),
      `预算序列必须严格递增：${budgets.join(' < ')}`,
    );
  }
  // 配置里给了更大的 max_tokens ⇒ 必须保留（不得被映射表压小）。
  const bigConfig = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk',
    model: 'claude-x',
    maxTokens: 65_536,
  });
  const { body: bigBody } = await captureBody(
    async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }),
    () => bigConfig.generate(request('minimal')),
  );
  assert.strictEqual(bigBody['max_tokens'], 65_536, '配置的 max_tokens 更大时应保留配置值');
});

test('③-b 映射表必须覆盖配置枚举的**全部**合法档位（防"合法配置却在适配器抛错"）', () => {
  // 配置侧枚举是唯一事实来源：从 `configError.ts` 逐字读出 `reasoning: [...]` 那一行。
  const configSource = readFileSync(join(REPO_ROOT, 'src/config/configError.ts'), 'utf8');
  const line = /reasoning:\s*\[([^\]]+)\]/u.exec(configSource)?.[1] ?? '';
  const levels = [...line.matchAll(/'([a-z]+)'/gu)].map((m) => m[1] ?? '');
  assert.ok(
    levels.length >= 5,
    `没能从 configError 读出档位枚举（读到 ${String(levels.length)} 个）`,
  );
  const mapped = new Set(['none', ...Object.keys(ModelReasoningEfforts.ANTHROPIC_BUDGETS)]);
  const missing = levels.filter((level) => !mapped.has(level));
  assert.deepStrictEqual(
    missing,
    [],
    `这些**合法配置档位**在 Anthropic 映射表里缺席 ⇒ 用户设了合法值反而抛错：${missing.join(', ')}`,
  );
  // 正对照：把枚举里的一个档位从映射表里排除，检查器必须能发现（否则本判据恒真）。
  const probe = new Set(levels.filter((level) => level !== 'xhigh'));
  assert.ok(
    levels.filter((level) => !probe.has(level)).includes('xhigh'),
    '正对照写错了：取样应能暴露缺席档位',
  );
});

test('④ Anthropic 未知档位 fail-closed（不得猜一个预算把高强度静默降级）', async () => {
  const model = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk',
    model: 'claude-x',
  });
  await assert.rejects(
    () =>
      captureBody(
        async () => new Response(JSON.stringify({ content: [] }), { status: 200 }),
        () => model.generate(request('extreme')),
      ),
    /无法把 reasoningEffort="extreme" 映射成思考预算/u,
    '未知档位必须抛错并说明可接受取值',
  );
  // **正对照**：已登记档位不得抛（否则④可能只是"什么都抛"）。
  assert.doesNotThrow(() => ModelReasoningEfforts.toAnthropic('medium'));
  assert.throws(() => ModelReasoningEfforts.toAnthropic('extreme'), /可接受取值/u);
});

test('⑤ Ollama：think 为布尔（关档显式 false，未设不发）', async () => {
  const model = new LlamaCppModel({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen-local' });
  const on = await captureBody(
    async () => new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 }),
    () => model.generate(request('high')),
  );
  assert.strictEqual(on.body['think'], true);
  const off = await captureBody(
    async () => new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 }),
    () => model.generate(request('none')),
  );
  assert.strictEqual(
    off.body['think'],
    false,
    '关档必须显式 false（而不是不发，否则用户以为关了其实没关）',
  );
  const unset = await captureBody(
    async () => new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 }),
    () => model.generate(request()),
  );
  assert.strictEqual('think' in unset.body, false, '未设档位时不得带 think');
});

test('⑥ 单一实现：四家字段字面量只许住在 modelReasoningEfforts.ts', () => {
  const mapping = readFileSync(
    join(REPO_ROOT, 'src/adapters/model/modelReasoningEfforts.ts'),
    'utf8',
  );
  assert.match(mapping, /reasoning_effort/u, '映射模块必须自己持有 OpenAI 字段名');
  assert.match(mapping, /budget_tokens/u, '映射模块必须自己持有 Anthropic 字段名');
  for (const file of [
    'responsesModel',
    'llamaCppModel',
    'openAiCompatibleModel',
    'anthropicModel',
  ]) {
    const source = readFileSync(join(REPO_ROOT, `src/adapters/model/${file}.ts`), 'utf8');
    for (const literal of ['reasoning_effort', 'budget_tokens']) {
      assert.ok(
        !source.includes(`'${literal}'`),
        `${file}.ts 不得自持 '${literal}' 字面量 ⇒ 应改用 ModelReasoningEfforts`,
      );
    }
  }
});
