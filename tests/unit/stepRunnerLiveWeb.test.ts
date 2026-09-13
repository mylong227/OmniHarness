import { RepoMapContextEngine } from '../../src/context/repoMapContextEngine.js';
// StepRunner × 流式路径 × Web 推送 集成测试（#B3 web 端到端）：
// StepRunner 走 stream → live(CompositeLiveView 内含 WebLiveView) → 经 bridge.notify 推送 thread.tool_input。
// 证明「核心循环 stream 增量 → 广播给 Web UI」链路真实闭环，而非仅单元正确。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StepRunner } from '../../src/core/stepRunner.js';
import { SessionRecorder } from '../../src/core/sessionRecorder.js';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { CompositeLiveView } from '../../src/adapters/live/compositeLiveView.js';
import { WebLiveView, type LiveBroadcaster } from '../../src/adapters/live/webLiveView.js';
import type { ModelPort, ModelOutput } from '../../src/ports/model/model.js';
import type { ToolCall } from '../../src/ports/tool/tool.js';
import type { ToolPort } from '../../src/ports/tool/tool.js';
import type { ApprovalPort } from '../../src/ports/runtime/approval.js';
import type { SandboxPort } from '../../src/ports/runtime/sandbox.js';

const echoTool: ToolCall = { id: 'c1', name: 'shell.run', arguments: { command: 'echo hi' } };
const allowApproval: ApprovalPort = { name: 'allow', decide: async () => 'allow' };
const sandboxOk: SandboxPort = { name: 'ok', check: async () => ({ allowed: true }) };
const jsTools: ToolPort = {
  name: 'js',
  list: () => [],
  execute: async (c) => ({ callId: c.id, ok: true, output: 'js-ran' }),
};

test('StepRunner stream 路径经 composite→WebLiveView→bridge 推送 thread.tool_input', async () => {
  const recorder = new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), 's-web');
  const calls: { method: string; params: unknown }[] = [];
  const bridge: LiveBroadcaster = { notify: (m, p) => calls.push({ method: m, params: p }) };
  const live = new CompositeLiveView([new WebLiveView(bridge)]);
  const model: ModelPort = {
    name: 'mock',
    // 走 generate 即失败：证明确实走了 stream 路径。
    generate: async (): Promise<ModelOutput> => {
      throw new Error('不应调用 generate');
    },
    stream: async (_req, cb) => {
      cb.onToolInput?.({ id: 'c1', name: 'shell.run', partialJson: '{"command":"echo' });
      cb.onToolInput?.({ id: 'c1', name: 'shell.run', partialJson: ' hi"}' });
      return { toolCalls: [echoTool] };
    },
  };
  const sr = new StepRunner({
    model,
    tools: jsTools,
    approvals: allowApproval,
    sandbox: sandboxOk,
    repoMapContext: new RepoMapContextEngine(),
    recorder,
    sessionId: 's-web',
    live,
  });
  const outcome = await sr.run({ sessionId: 's-web', workspaceRoot: '/tmp' });
  assert.strictEqual(outcome, 'tool', '工具调用应正常执行');
  const toolInputs = calls.filter((c) => c.method === 'thread.tool_input');
  assert.strictEqual(toolInputs.length, 2, '应推送 2 次 thread.tool_input');
  assert.deepStrictEqual(toolInputs[0]!.params, {
    id: 'c1',
    name: 'shell.run',
    partialJson: '{"command":"echo',
  });
  assert.deepStrictEqual(toolInputs[1]!.params, {
    id: 'c1',
    name: 'shell.run',
    partialJson: ' hi"}',
  });
  // 组合未含 ConsoleLiveView，不应混入其它通知。
  assert.strictEqual(
    calls.every((c) => c.method === 'thread.tool_input'),
    true,
  );
});

test('StepRunner stream 路径的正文增量经 composite→WebLiveView→bridge 推送 thread.text_delta', async () => {
  const recorder = new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), 's-text');
  const calls: { method: string; params: unknown }[] = [];
  const bridge: LiveBroadcaster = { notify: (m, p) => calls.push({ method: m, params: p }) };
  const live = new CompositeLiveView([new WebLiveView(bridge)]);
  const model: ModelPort = {
    name: 'mock',
    // 走 generate 即失败：证明确实走了 stream 路径。
    generate: async (): Promise<ModelOutput> => {
      throw new Error('不应调用 generate');
    },
    stream: async (_req, cb) => {
      cb.onText('你好');
      cb.onText('，世界');
      return { text: '你好，世界' };
    },
  };
  const sr = new StepRunner({
    model,
    tools: jsTools,
    approvals: allowApproval,
    sandbox: sandboxOk,
    repoMapContext: new RepoMapContextEngine(),
    recorder,
    sessionId: 's-text',
    live,
  });
  const outcome = await sr.run({ sessionId: 's-text', workspaceRoot: '/tmp' });
  assert.strictEqual(outcome, 'text', '纯文本输出应以 text 收尾');
  const deltas = calls
    .filter((c) => c.method === 'thread.text_delta')
    .map((c) => (c.params as { text: string }).text);
  assert.deepStrictEqual(
    deltas,
    ['你好', '，世界'],
    '每段都应是增量片段（不是累积全文），前端据此 append',
  );
  // 收尾的 assistant 事实事件仍走 recorder（与增量观感解耦，事实源不被过程性推送污染）。
  const events = recorder.allEvents();
  const assistant = events.filter((e) => e.type === 'assistant');
  assert.strictEqual(assistant.length, 1, '正文必须以 assistant 事实事件落账');
  const assistantPayload = assistant[0]!.payload as { content?: string };
  assert.strictEqual(assistantPayload.content, '你好，世界');
});
