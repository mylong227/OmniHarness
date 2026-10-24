/**
 * AG-UI 适配层判据（事件映射 / 顺序 / 错误 / 取消 / HTTP-SSE 端点）。
 *
 * 映射依据：https://docs.ag-ui.com/sdk/js/core/events（EventType 与事件字段）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { eventFactory } from '../../src/core/eventFactory.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';
import {
  AgUiEventMapper,
  AgUiEventStream,
  AgUiHttpServer,
  type AgUiAgentRunner,
  type AgUiEvent,
} from '../../src/agui/index.ts';

async function drain(events: AsyncIterable<AgUiEvent>): Promise<AgUiEvent[]> {
  const out: AgUiEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function typeOf(event: AgUiEvent): string {
  return event.type;
}

test('1) 事件映射：assistant → TEXT_MESSAGE_*；tool_call → TOOL_CALL_*；todo → STATE_SNAPSHOT', () => {
  const mapper = new AgUiEventMapper({ threadId: 't1', runId: 'r1' });
  const assistant = mapper.map(eventFactory.assistant('s', 'hello'));
  assert.deepStrictEqual(assistant.map(typeOf), [
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END',
  ]);
  const content = assistant[1] as { readonly delta?: string };
  assert.strictEqual(content.delta, 'hello');

  const toolCall = mapper.map(eventFactory.toolCall('s', 'call-1', 'read_file', { path: 'a.ts' }));
  assert.deepStrictEqual(toolCall.map(typeOf), [
    'TOOL_CALL_START',
    'TOOL_CALL_ARGS',
    'TOOL_CALL_END',
  ]);
  assert.strictEqual((toolCall[0] as { toolCallName?: string }).toolCallName, 'read_file');
  assert.match((toolCall[1] as { delta?: string }).delta ?? '', /a\.ts/u);

  const result = mapper.map(eventFactory.toolResult('s', 'call-1', true, 'file body'));
  assert.strictEqual(result[0]?.type, 'TOOL_CALL_RESULT');
  assert.strictEqual((result[0] as { content?: string }).content, 'file body');

  const todo = mapper.map(eventFactory.todo('s', [{ content: 'step', status: 'in_progress' }]));
  assert.strictEqual(todo[0]?.type, 'STATE_SNAPSHOT');
  assert.deepStrictEqual((todo[0] as { snapshot?: { todos?: unknown } }).snapshot?.todos, [
    { content: 'step', status: 'in_progress' },
  ]);
});

test('2) 事件流顺序：RUN_STARTED → 映射事件 → RUN_FINISHED（含 finalText/steps）', async () => {
  const stream = new AgUiEventStream({ threadId: 't2', runId: 'r2' });
  const events = async function* (): AsyncIterable<SessionEvent> {
    yield eventFactory.assistant('s', '第一段');
    yield eventFactory.toolCall('s', 'call-2', 'shell', { command: 'echo hi' });
    yield eventFactory.toolResult('s', 'call-2', true, 'hi');
  };
  const out = await drain(stream.run(events()));
  assert.strictEqual(out[0]?.type, 'RUN_STARTED');
  assert.strictEqual(out.at(-1)?.type, 'RUN_FINISHED');
  const result = (out.at(-1) as { result?: { finalText?: string; steps?: number } }).result;
  assert.strictEqual(result?.finalText, '第一段');
  assert.ok((result?.steps ?? 0) >= 2);
  const types = out.map(typeOf);
  assert.ok(types.indexOf('TEXT_MESSAGE_END') < types.indexOf('TOOL_CALL_START'));
  assert.ok(types.indexOf('TOOL_CALL_RESULT') < types.indexOf('RUN_FINISHED'));
});

test('3) 错误路径：运行器抛错收敛为 RUN_ERROR（保留已产出事件）', async () => {
  const stream = new AgUiEventStream({ threadId: 't3', runId: 'r3' });
  const events = async function* (): AsyncIterable<SessionEvent> {
    yield eventFactory.assistant('s', '开始');
    throw new Error('模型超时');
  };
  const out = await drain(stream.run(events()));
  assert.strictEqual(out[0]?.type, 'RUN_STARTED');
  assert.ok(out.some((event) => event.type === 'TEXT_MESSAGE_CONTENT'));
  const error = out.at(-1) as { type?: string; message?: string };
  assert.strictEqual(error.type, 'RUN_ERROR');
  assert.match(error.message ?? '', /模型超时/u);
});

test('4) 取消：abort 后以 RUN_ERROR/CANCELLED 收尾，且不再映射后续事件', async () => {
  const controller = new AbortController();
  const stream = new AgUiEventStream({ threadId: 't4', runId: 'r4' });
  const events = async function* (): AsyncIterable<SessionEvent> {
    yield eventFactory.assistant('s', '一条');
    controller.abort();
    yield eventFactory.assistant('s', '不应出现');
  };
  const out = await drain(stream.run(events(), controller.signal));
  const error = out.at(-1) as { type?: string; code?: string };
  assert.strictEqual(error.type, 'RUN_ERROR');
  assert.strictEqual(error.code, 'CANCELLED');
  assert.ok(
    !out.some(
      (event) =>
        event.type === 'TEXT_MESSAGE_CONTENT' && (event as { delta?: string }).delta === '不应出现',
    ),
    '取消后的源事件不应再被映射',
  );
});

test('5) HTTP/SSE 端点：POST /agui 按序回写事件并以 RUN_FINISHED 收尾', async () => {
  const runner: AgUiAgentRunner = async function* (): AsyncIterable<SessionEvent> {
    yield eventFactory.assistant('s', '来自 runner');
  };
  const server = new AgUiHttpServer({ run: runner });
  const port = await server.listen(0);
  try {
    const health = await fetch(`http://127.0.0.1:${String(port)}/agui/health`);
    assert.strictEqual(health.status, 200);
    const response = await fetch(`http://127.0.0.1:${String(port)}/agui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 't5', runId: 'r5', messages: [] }),
    });
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u);
    const text = await response.text();
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as AgUiEvent);
    assert.deepStrictEqual(events.map(typeOf), [
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ]);
  } finally {
    server.close();
  }
});
