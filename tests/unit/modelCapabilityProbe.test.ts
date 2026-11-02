/**
 * 模型**能力探针**判据（U2-4，2026-10-30）。
 *
 * 探针的价值在「失败模式按能力逐项拆开」——mock 端口逐条编排应答，钉住：
 * 全绿卡 / 工具不调用 / 并行只回一个 / JSON 不可解析 / 请求层 error 与行为 fail 分开 /
 * 无 stream ⇒ unsupported / 渲染两态（表 + JSON）。端口级探测**不做缓存**（厂商字段 + 时序，
 * 结论不可信——见探针类头的诚实边界）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ModelPort, ModelRequest, ModelOutput } from '../../src/contracts/ports/model/model.ts';
import { ModelCapabilityProbe } from '../../src/kernel/adapters/model/modelCapabilityProbe.ts';
import type { ModelToolCallRef } from '../../src/contracts/ports/model/modelToolCallRef.ts';

/** 按请求特征决定应答的 mock（特征谓词表驱动）。 */
function scripted(
  rules: readonly {
    readonly match: (req: ModelRequest) => boolean;
    readonly reply: () => ModelOutput;
  }[],
  record: ModelRequest[],
): ModelPort {
  return {
    name: 'mock-probe',
    generate: async (req: ModelRequest): Promise<ModelOutput> => {
      record.push(req);
      const rule = rules.find((r) => r.match(req));
      if (rule === undefined) return { text: 'OK' };
      return rule.reply();
    },
  };
}

const hasTool = (req: ModelRequest, name: string) => req.tools.some((t) => t.name === name);
const asked = (req: ModelRequest, keyword: string) =>
  req.messages.some((m) => typeof m.content === 'string' && m.content.includes(keyword));

const toolCall = (name: string): ModelToolCallRef => ({ id: `c-${name}`, name, arguments: {} });

test('探针：全绿端口 ⇒ ok 卡，六项全 pass', async () => {
  const record: ModelRequest[] = [];
  const model = scripted(
    [
      {
        match: (r) => hasTool(r, 'get_weather'),
        reply: () => ({ toolCalls: [toolCall('get_weather')] }),
      },
      {
        match: (r) => hasTool(r, 'get_time') && hasTool(r, 'get_date'),
        reply: () => ({ toolCalls: [toolCall('get_time'), toolCall('get_date')] }),
      },
      { match: (r) => asked(r, 'JSON'), reply: () => ({ text: '{"city":"杭州"}' }) },
      { match: (r) => asked(r, '好'), reply: () => ({ text: '好' }) },
    ],
    record,
  );

  const card = await ModelCapabilityProbe.run(model);

  assert.strictEqual(card.ok, true);
  assert.deepStrictEqual(
    card.probes.map((p) => `${p.id}:${p.status}`),
    [
      'basic:pass',
      'toolCalling:pass',
      'parallelTools:pass',
      'jsonOutput:pass',
      'reasoningEffort:pass',
      'streaming:unsupported',
    ],
    'mock 无 stream ⇒ streaming 是 unsupported（不阻断），其余全 pass',
  );
  assert.strictEqual(record.length, 5, 'streaming unsupported 不发请求，共 5 条小请求');
});

test('探针：失败模式按项拆开——不调工具 / 并行只回一个 / JSON 不可解析 / 请求层 error', async () => {
  const model = scripted(
    [
      { match: (r) => hasTool(r, 'get_weather'), reply: () => ({ text: '今天天气不错' }) },
      {
        match: (r) => hasTool(r, 'get_time'),
        reply: () => ({ toolCalls: [toolCall('get_time')] }),
      },
      {
        match: (r) => asked(r, 'JSON'),
        reply: () => ({ text: '我觉得 JSON 是一种很 json 的东西' }),
      },
      {
        match: (r) => r.reasoningEffort === 'low',
        reply: () => {
          throw new Error('HTTP 401 未授权');
        },
      },
    ],
    [],
  );

  const card = await ModelCapabilityProbe.run(model);

  assert.strictEqual(card.ok, false, '有 fail/error ⇒ ok=false');
  const byId = new Map(card.probes.map((p) => [p.id, p]));
  assert.strictEqual(byId.get('toolCalling')?.status, 'fail', '文本描述 ≠ 工具调用');
  assert.strictEqual(
    byId.get('parallelTools')?.status,
    'fail',
    '只回一个调用 = 并行能力缺失（fail，不是 error）',
  );
  assert.ok(
    (byId.get('parallelTools')?.detail ?? '').includes('串行'),
    'fail 的 detail 要说明 harness 的退化路径',
  );
  assert.strictEqual(byId.get('jsonOutput')?.status, 'fail', '不可解析 = fail');
  assert.strictEqual(
    byId.get('reasoningEffort')?.status,
    'error',
    '请求层 401 = error（与行为 fail 分开）',
  );
  assert.strictEqual(byId.get('basic')?.status, 'pass', 'basic 不带工具不问 JSON ⇒ 走默认 OK');
});

test('探针：流式端口走 stream 并拼接文本', async () => {
  const model: ModelPort = {
    name: 'mock-stream',
    generate: async () => ({ text: 'OK' }),
    stream: async (_req, cb) => {
      cb.onText('O');
      cb.onText('K');
      return { text: 'OK' };
    },
  };

  const card = await ModelCapabilityProbe.run(model);

  const streaming = card.probes.find((p) => p.id === 'streaming');
  assert.strictEqual(streaming?.status, 'pass');
  assert.ok((streaming?.detail ?? '').includes('OK'), '拼接增量文本进证据');
});

test('探针：渲染——表格给人看、JSON 逐位同构', async () => {
  const card: Awaited<ReturnType<typeof ModelCapabilityProbe.run>> = {
    model: 'm',
    ok: false,
    probes: [
      { id: 'basic', title: '基础补全', status: 'pass', detail: 'text=OK' },
      { id: 'toolCalling', title: '工具调用', status: 'error', detail: 'HTTP 401' },
    ],
  };
  const text = ModelCapabilityProbe.render(card, false);
  assert.ok(text.includes('模型能力卡：m'), '表头含模型名');
  assert.ok(text.includes('✗ error'), 'error 有独立标记');
  assert.ok(text.includes('结论：存在 fail/error 项'));

  const json = ModelCapabilityProbe.render(card, true);
  const parsed = JSON.parse(json) as typeof card;
  assert.deepStrictEqual(parsed, card, 'JSON 渲染与原卡逐位同构');
});

test('探针：确定性——同一端口两次跑结果一致', async () => {
  const build = () =>
    scripted(
      [
        {
          match: (r) => hasTool(r, 'get_weather'),
          reply: () => ({ toolCalls: [toolCall('get_weather')] }),
        },
        {
          match: (r) => hasTool(r, 'get_time'),
          reply: () => ({ toolCalls: [toolCall('get_time'), toolCall('get_date')] }),
        },
      ],
      [],
    );
  const one = await ModelCapabilityProbe.run(build());
  const two = await ModelCapabilityProbe.run(build());
  assert.deepStrictEqual(one, two);
});
