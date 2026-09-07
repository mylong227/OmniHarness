// StepRunner × 流式路径集成测试（#B3 接线）：验证「live 端口 + model.stream」正确转发
// 工具参数增量，并在不传 live 或模型不支持 stream 时 fail-closed 退回 generate 路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StepRunner } from '../../src/core/stepRunner.js';
import { SessionRecorder } from '../../src/core/sessionRecorder.js';
import { AppendOnlyEventLog } from '../../src/core/eventLog.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import type { ModelPort, ModelOutput, ToolInputDelta } from '../../src/ports/model.js';
import type { ToolPort, ToolCall } from '../../src/ports/tool.js';
import type { ApprovalPort } from '../../src/ports/approval.js';
import type { SandboxPort } from '../../src/ports/sandbox.js';
import type { ToolInputSink } from '../../src/ports/toolInputSink.js';

function recorderFor(sessionId: string): SessionRecorder {
  return new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), sessionId);
}

const echoTool: ToolCall = { id: 'c1', name: 'shell.run', arguments: { command: 'echo hi' } };
const allowApproval: ApprovalPort = { name: 'allow', decide: async () => 'allow' };
const sandboxOk: SandboxPort = { name: 'ok', check: async () => ({ allowed: true }) };
const jsTools: ToolPort = {
  name: 'js',
  list: () => [],
  execute: async (c) => ({ callId: c.id, ok: true, output: 'js-ran' }),
};

test('live 存在且模型支持 stream：走 stream 并转发工具参数增量', async () => {
  const recorder = recorderFor('s1');
  const deltas: ToolInputDelta[] = [];
  const live: ToolInputSink = { name: 'sink', onToolInput: (d) => deltas.push(d) };
  let streamCalled = false;
  const model: ModelPort = {
    name: 'mock',
    // 若走到 generate 即失败：证明确实走了 stream 路径。
    generate: async (): Promise<ModelOutput> => {
      throw new Error('不应调用 generate');
    },
    stream: async (_req, cb) => {
      streamCalled = true;
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
    recorder,
    sessionId: 's1',
    live,
  });
  const outcome = await sr.run({ sessionId: 's1', workspaceRoot: '/tmp' });
  assert.strictEqual(streamCalled, true, '应走 stream 路径');
  assert.strictEqual(deltas.length, 2, '应转发 2 次增量');
  assert.strictEqual(deltas[0]!.partialJson, '{"command":"echo', '首段应原样转发');
  assert.strictEqual(outcome, 'tool', '工具调用应正常执行');
  assert.strictEqual(
    recorder.allEvents().filter((e) => e.type === 'tool_result').length,
    1,
    '应记录一条工具结果',
  );
});

test('live 存在但模型无 stream：fail-closed 回退 generate', async () => {
  const recorder = recorderFor('s2');
  let forwarded = false;
  const live: ToolInputSink = {
    name: 'sink',
    onToolInput: () => {
      forwarded = true;
    },
  };
  const model: ModelPort = {
    name: 'mock',
    generate: async (): Promise<ModelOutput> => ({ toolCalls: [echoTool] }),
  };
  const sr = new StepRunner({
    model,
    tools: jsTools,
    approvals: allowApproval,
    sandbox: sandboxOk,
    recorder,
    sessionId: 's2',
    live,
  });
  const outcome = await sr.run({ sessionId: 's2', workspaceRoot: '/tmp' });
  assert.strictEqual(forwarded, false, '无 stream 时不应转发增量');
  assert.strictEqual(outcome, 'tool', '工具调用应正常执行（generate 路径）');
  assert.strictEqual(recorder.allEvents().filter((e) => e.type === 'tool_result').length, 1);
});

test('无 live：即便模型支持 stream 也走 generate', async () => {
  const recorder = recorderFor('s3');
  let streamCalled = false;
  const model: ModelPort = {
    name: 'mock',
    generate: async (): Promise<ModelOutput> => ({ toolCalls: [echoTool] }),
    stream: async () => {
      streamCalled = true;
      return { toolCalls: [echoTool] };
    },
  };
  const sr = new StepRunner({
    model,
    tools: jsTools,
    approvals: allowApproval,
    sandbox: sandboxOk,
    recorder,
    sessionId: 's3',
  });
  const outcome = await sr.run({ sessionId: 's3', workspaceRoot: '/tmp' });
  assert.strictEqual(streamCalled, false, '无 live 应走 generate，不调用 stream');
  assert.strictEqual(outcome, 'tool');
});
