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
  type AgUiActivityDeltaEvent,
  type AgUiActivitySnapshotEvent,
  type AgUiAgentRunner,
  type AgUiEvent,
  type AgUiStateDeltaEvent,
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

test('6) STATE_DELTA add：首个状态发快照，新增状态键发 JSON Patch add', () => {
  const mapper = new AgUiEventMapper({ threadId: 't6', runId: 'r6' });
  const todos = [{ content: 'step', status: 'pending' }];
  const first = mapper.map(eventFactory.todo('s', todos));
  assert.deepStrictEqual(first.map(typeOf), ['STATE_SNAPSHOT']);

  const plan = { steps: ['检查', '修改'] };
  const added = mapper.map(eventFactory.plan('s', plan));
  assert.deepStrictEqual(added.map(typeOf), ['STATE_DELTA']);
  assert.deepStrictEqual((added[0] as AgUiStateDeltaEvent).delta, [
    { op: 'add', path: '/plan', value: plan },
  ]);
});

test('7) STATE_DELTA replace：既有状态键变化发 JSON Patch replace', () => {
  const mapper = new AgUiEventMapper({ threadId: 't7', runId: 'r7' });
  mapper.map(eventFactory.todo('s', [{ content: 'step', status: 'pending' }]));
  const next = [{ content: 'step', status: 'completed' }];
  const events = mapper.map(eventFactory.todo('s', next));
  assert.deepStrictEqual(events.map(typeOf), ['STATE_DELTA']);
  assert.deepStrictEqual((events[0] as AgUiStateDeltaEvent).delta, [
    { op: 'replace', path: '/todos', value: next },
  ]);
});

test('8) STATE_DELTA remove：状态键清除发 remove；无变化不发空 delta', () => {
  const mapper = new AgUiEventMapper({ threadId: 't8', runId: 'r8' });
  const todos = [{ content: 'step', status: 'pending' }];
  mapper.map(eventFactory.todo('s', todos));
  mapper.map(eventFactory.plan('s', { steps: ['x'] }));

  const removed = mapper.mapState({ todos });
  assert.deepStrictEqual(removed.map(typeOf), ['STATE_DELTA']);
  assert.deepStrictEqual((removed[0] as AgUiStateDeltaEvent).delta, [
    { op: 'remove', path: '/plan' },
  ]);

  assert.deepStrictEqual(mapper.mapState({ todos }), [], '相同状态不应产生空 delta');
  assert.deepStrictEqual(
    mapper.map(eventFactory.todo('s', todos)),
    [],
    '重复的 todo 不应产生空 delta',
  );
});

test('9) ACTIVITY：工具执行中发 ACTIVITY_SNAPSHOT，完成发 ACTIVITY_DELTA', async () => {
  const stream = new AgUiEventStream({ threadId: 't9', runId: 'r9' });
  const events = async function* (): AsyncIterable<SessionEvent> {
    yield eventFactory.toolCall('s', 'call-9', 'shell', { command: 'echo hi' });
    yield eventFactory.toolResult('s', 'call-9', true, 'hi');
  };
  const out = await drain(stream.run(events()));
  const activities = out.filter(
    (event) => event.type === 'ACTIVITY_SNAPSHOT' || event.type === 'ACTIVITY_DELTA',
  );
  assert.strictEqual(activities.length, 2);

  const snapshot = activities[0] as AgUiActivitySnapshotEvent;
  assert.strictEqual(snapshot.type, 'ACTIVITY_SNAPSHOT');
  assert.strictEqual(snapshot.activityType, 'TOOL_CALL');
  assert.strictEqual(snapshot.content['toolCallId'], 'call-9');
  assert.strictEqual(snapshot.content['status'], 'running');
  assert.strictEqual(snapshot.content['name'], 'shell');

  const delta = activities[1] as AgUiActivityDeltaEvent;
  assert.strictEqual(delta.type, 'ACTIVITY_DELTA');
  assert.strictEqual(delta.messageId, snapshot.messageId);
  assert.strictEqual(delta.activityType, 'TOOL_CALL');
  assert.deepStrictEqual(delta.patch, [{ op: 'replace', path: '/status', value: 'completed' }]);
});

test('10) 子代理：真实 subagent 工具调用映射为 SUBAGENT 活动开始/结束', async () => {
  const stream = new AgUiEventStream({ threadId: 't10', runId: 'r10' });
  const events = async function* (): AsyncIterable<SessionEvent> {
    yield eventFactory.toolCall('s', 'call-10', 'subagent', { task: '检查模块' });
    yield eventFactory.toolResult('s', 'call-10', true, '[子智能体 sess-1] 3 步');
  };
  const out = await drain(stream.run(events()));
  const activities = out.filter(
    (event) => event.type === 'ACTIVITY_SNAPSHOT' || event.type === 'ACTIVITY_DELTA',
  );
  assert.strictEqual(activities.length, 2);

  const snapshot = activities[0] as AgUiActivitySnapshotEvent;
  assert.strictEqual(snapshot.activityType, 'SUBAGENT');
  assert.strictEqual(snapshot.content['task'], '检查模块');
  assert.strictEqual(snapshot.content['status'], 'running');

  const delta = activities[1] as AgUiActivityDeltaEvent;
  assert.strictEqual(delta.activityType, 'SUBAGENT');
  assert.strictEqual(delta.messageId, snapshot.messageId);
  assert.deepStrictEqual(delta.patch, [{ op: 'replace', path: '/status', value: 'completed' }]);
});

test('11) 无对应事件时不伪造活动/子代理事件', () => {
  const mapper = new AgUiEventMapper({ threadId: 't11', runId: 'r11' });
  assert.deepStrictEqual(mapper.activities(eventFactory.system('s', 'notice')), []);
  assert.deepStrictEqual(mapper.activities(eventFactory.user('s', 'hi')), []);
  assert.deepStrictEqual(
    mapper.activities(eventFactory.toolResult('s', 'orphan-call', true, 'late')),
    [],
    '没有 tool_call 的 tool_result 不得伪造子代理/活动',
  );
  const normal = mapper.activities(eventFactory.toolCall('s', 'call-11', 'shell', {}));
  assert.strictEqual((normal[0] as AgUiActivitySnapshotEvent).activityType, 'TOOL_CALL');
});

test('12) MESSAGES_SNAPSHOT：run 开始时先于映射事件发送；无历史则不发', async () => {
  const messages = [{ id: 'm1', role: 'user', content: '你好' }];
  const stream = new AgUiEventStream({ threadId: 't12', runId: 'r12', messages });
  const events = async function* (): AsyncIterable<SessionEvent> {
    yield eventFactory.assistant('s', '回复');
  };
  const out = await drain(stream.run(events()));
  assert.deepStrictEqual(out.map(typeOf), [
    'RUN_STARTED',
    'MESSAGES_SNAPSHOT',
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END',
    'RUN_FINISHED',
  ]);
  assert.deepStrictEqual((out[1] as { messages?: readonly unknown[] }).messages, messages);

  const emptyStream = new AgUiEventStream({ threadId: 't12b', runId: 'r12b' });
  const emptyEvents = async function* (): AsyncIterable<SessionEvent> {
    yield eventFactory.assistant('s', '回复');
  };
  const withoutSnapshot = await drain(emptyStream.run(emptyEvents()));
  assert.ok(!withoutSnapshot.some((event) => event.type === 'MESSAGES_SNAPSHOT'));
});

test('13) 取消：快照与活动开始之后取消，不再映射后续结果', async () => {
  const controller = new AbortController();
  const stream = new AgUiEventStream({
    threadId: 't13',
    runId: 'r13',
    messages: [{ id: 'm1', role: 'user', content: '开始' }],
  });
  const events = async function* (): AsyncIterable<SessionEvent> {
    yield eventFactory.toolCall('s', 'call-13', 'shell', { command: 'sleep 10' });
    controller.abort();
    yield eventFactory.toolResult('s', 'call-13', true, '不应出现');
  };
  const out = await drain(stream.run(events(), controller.signal));
  assert.strictEqual(out[0]?.type, 'RUN_STARTED');
  assert.strictEqual(out[1]?.type, 'MESSAGES_SNAPSHOT');
  assert.ok(out.some((event) => event.type === 'ACTIVITY_SNAPSHOT'));
  const last = out.at(-1) as { type?: string; code?: string };
  assert.strictEqual(last.type, 'RUN_ERROR');
  assert.strictEqual(last.code, 'CANCELLED');
  assert.ok(!out.some((event) => event.type === 'RUN_FINISHED'));
  assert.ok(
    !out.some((event) => event.type === 'ACTIVITY_DELTA'),
    '取消后的 tool_result 不应再映射为活动完成',
  );
});

test('14) HTTP/SSE：非空 messages 发 MESSAGES_SNAPSHOT，工具活动随流下发', async () => {
  const runner: AgUiAgentRunner = async function* (): AsyncIterable<SessionEvent> {
    yield eventFactory.toolCall('s', 'call-14', 'shell', { command: 'echo hi' });
    yield eventFactory.toolResult('s', 'call-14', true, 'hi');
  };
  const server = new AgUiHttpServer({ run: runner });
  const port = await server.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/agui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: 't14',
        runId: 'r14',
        messages: [{ id: 'm1', role: 'user', content: '跑一下' }],
      }),
    });
    assert.strictEqual(response.status, 200);
    const text = await response.text();
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as AgUiEvent);
    assert.deepStrictEqual(events.map(typeOf).slice(0, 2), ['RUN_STARTED', 'MESSAGES_SNAPSHOT']);
    assert.ok(events.some((event) => event.type === 'ACTIVITY_SNAPSHOT'));
    assert.ok(events.some((event) => event.type === 'ACTIVITY_DELTA'));
    assert.strictEqual(events.at(-1)?.type, 'RUN_FINISHED');
  } finally {
    server.close();
  }
});
