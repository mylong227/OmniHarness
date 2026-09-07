// stepRunner × native 后端集成测试（#67）：验证 --approval/--sandbox 门禁在 native 与 JS 路径下行为一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StepRunner } from '../../src/core/stepRunner.js';
import { SessionRecorder } from '../../src/core/sessionRecorder.js';
import { AppendOnlyEventLog } from '../../src/core/eventLog.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import type { ModelPort, ModelOutput } from '../../src/ports/model.js';
import type { ToolPort, ToolCall } from '../../src/ports/tool.js';
import type { ApprovalPort } from '../../src/ports/approval.js';
import type { SandboxPort } from '../../src/ports/sandbox.js';
import type { NativeToolRunner } from '../../src/native/nativeBackend.js';

function recorderFor(sessionId: string): SessionRecorder {
  return new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), sessionId);
}

function modelReturning(calls: ToolCall[]): ModelPort {
  return {
    name: 'mock',
    generate: async (): Promise<ModelOutput> => ({ toolCalls: calls }),
  };
}

const echoTool: ToolCall = { id: 'c1', name: 'shell.run', arguments: { command: 'echo hi' } };

const allowApproval: ApprovalPort = { name: 'allow', decide: async () => 'allow' };
const sandboxOk: SandboxPort = { name: 'ok', check: async () => ({ allowed: true }) };
const jsTools: ToolPort = {
  name: 'js',
  list: () => [],
  execute: async (c) => ({ callId: c.id, ok: true, output: 'js-ran' }),
};

test('native 路径下 --approval deny 仍拦截，不进内核', async () => {
  const recorder = recorderFor('s1');
  let nativeCalls = 0;
  const native: NativeToolRunner = {
    runTool: () => {
      nativeCalls++;
      return { callId: 'c1', ok: true, output: 'native' };
    },
  };
  const approvals: ApprovalPort = { name: 'deny', decide: async () => 'deny' };
  const sr = new StepRunner({
    model: modelReturning([echoTool]),
    tools: jsTools,
    approvals,
    sandbox: sandboxOk,
    recorder,
    sessionId: 's1',
    native,
  });
  await sr.run({ sessionId: 's1', workspaceRoot: '/tmp' });
  assert.strictEqual(nativeCalls, 0, 'deny 不应进原生内核，门禁须前置拦截');
  const results = recorder.allEvents().filter((e) => e.type === 'tool_result');
  assert.strictEqual(results.length, 1, '应记录一条被拒结果');
  assert.strictEqual((results[0] as unknown as { payload: { ok: boolean } }).payload.ok, false);
});

test('native 路径下 --approval allow 走内核执行', async () => {
  const recorder = recorderFor('s2');
  let nativeCalls = 0;
  const native: NativeToolRunner = {
    runTool: (c) => {
      nativeCalls++;
      return { callId: c.id, ok: true, output: 'native-ran' };
    },
  };
  const sr = new StepRunner({
    model: modelReturning([echoTool]),
    tools: jsTools,
    approvals: allowApproval,
    sandbox: sandboxOk,
    recorder,
    sessionId: 's2',
    native,
  });
  await sr.run({ sessionId: 's2', workspaceRoot: '/tmp' });
  assert.strictEqual(nativeCalls, 1, 'allow 应进原生内核');
  const results = recorder.allEvents().filter((e) => e.type === 'tool_result');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(
    (results[0] as unknown as { payload: { ok: boolean; output?: string } }).payload.ok,
    true,
  );
  assert.strictEqual(
    (results[0] as unknown as { payload: { ok: boolean; output?: string } }).payload.output,
    'native-ran',
  );
});

test('native 抛错时回退 JS 路径（门禁已通过，不重复）', async () => {
  const recorder = recorderFor('s3');
  let jsCalls = 0;
  const native: NativeToolRunner = {
    runTool: () => {
      throw new Error('kernel down');
    },
  };
  const tools: ToolPort = {
    name: 'js',
    list: () => [],
    execute: async (c) => {
      jsCalls++;
      return { callId: c.id, ok: true, output: 'js-ran' };
    },
  };
  const sr = new StepRunner({
    model: modelReturning([echoTool]),
    tools,
    approvals: allowApproval,
    sandbox: sandboxOk,
    recorder,
    sessionId: 's3',
    native,
  });
  await sr.run({ sessionId: 's3', workspaceRoot: '/tmp' });
  assert.strictEqual(jsCalls, 1, 'native 失败后应回退 JS 执行');
  const results = recorder.allEvents().filter((e) => e.type === 'tool_result');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(
    (results[0] as unknown as { payload: { ok: boolean; output?: string } }).payload.output,
    'js-ran',
  );
});

test('沙箱拒绝经 native 路径也生效（不进内核）', async () => {
  const recorder = recorderFor('s4');
  let nativeCalls = 0;
  const native: NativeToolRunner = {
    runTool: () => {
      nativeCalls++;
      return { callId: 'c1', ok: true, output: 'native' };
    },
  };
  const sandboxDeny: SandboxPort = {
    name: 'deny',
    check: async () => ({ allowed: false, reason: '路径越界' }),
  };
  const sr = new StepRunner({
    model: modelReturning([echoTool]),
    tools: jsTools,
    approvals: allowApproval,
    sandbox: sandboxDeny,
    recorder,
    sessionId: 's4',
    native,
  });
  await sr.run({ sessionId: 's4', workspaceRoot: '/tmp' });
  assert.strictEqual(nativeCalls, 0, '沙箱拒绝不应进原生内核');
  const results = recorder.allEvents().filter((e) => e.type === 'tool_result');
  assert.strictEqual(results.length, 1);
  assert.strictEqual((results[0] as unknown as { payload: { ok: boolean } }).payload.ok, false);
});
