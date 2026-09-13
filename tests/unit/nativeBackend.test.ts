import { RepoMapContextEngine } from '../../src/context/repoMapContextEngine.js';
// FFI 接入真实 agent 循环（#66）：StepRunner 原生路由 + JS 自动回退。
//
// 用 stub NativeToolRunner 解耦 .node 产物，不依赖 native:build。覆盖三态：
// ① 原生成功 → recorder 记录原生输出；② 原生抛错 → 回退 JS 执行；③ 原生业务拒绝 → 记 denied。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StepRunner } from '../../src/core/stepRunner.js';
import { SessionRecorder } from '../../src/core/sessionRecorder.js';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { ApprovalPort } from '../../src/ports/runtime/approval.js';
import type { ModelPort } from '../../src/ports/model/model.js';
import type { SandboxPort } from '../../src/ports/runtime/sandbox.js';
import type { ToolCall, ToolContext, ToolPort, ToolResult } from '../../src/ports/tool/tool.js';
import { NativeBackend } from '../../src/native/nativeBackend.js';
import type { NativeToolRunner } from '../../src/native/nativeBackend.js';

/** 捕获事件端口：收集 recorder 广播的全部事件，便于断言。 */
function capturePort(): { port: EventPort; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  return { port: { name: 'capture', emit: (e) => events.push(e) }, events };
}

/** 构造最小 StepRunner 依赖。native 为可选 stub；model 固定发一次指定工具调用。 */
function makeStep(
  toolName: string,
  native?: NativeToolRunner,
): {
  step: StepRunner;
  jsCalls: { count: number };
  emitted: SessionEvent[];
} {
  const { port, events } = capturePort();
  const recorder = new SessionRecorder(new AppendOnlyEventLog(), port, 's1');
  const jsCalls = { count: 0 };
  const model: ModelPort = {
    name: 'mock',
    generate: async () => ({
      toolCalls: [{ id: 'c1', name: toolName, arguments: { text: 'hi' } }],
    }),
  };
  const tools: ToolPort = {
    name: 'js',
    list: () => [],
    execute: async (call: ToolCall): Promise<ToolResult> => {
      jsCalls.count += 1;
      return { callId: call.id, ok: true, output: 'js-ran' };
    },
  };
  const approvals: ApprovalPort = { name: 'auto', decide: async () => 'allow' };
  const sandbox: SandboxPort = { name: 'sandbox', check: async () => ({ allowed: true }) };
  const step = new StepRunner({
    model,
    tools,
    approvals,
    sandbox,
    repoMapContext: new RepoMapContextEngine(),
    recorder,
    sessionId: 's1',
    native,
  });
  return { step, jsCalls, emitted: events };
}

const context: ToolContext = { sessionId: 's1', workspaceRoot: process.cwd() };

test('原生后端可用时：工具经 native 执行且 recorder 记录原生输出', async () => {
  let nativeCalls = 0;
  const native: NativeToolRunner = {
    runTool(call: ToolCall): ToolResult {
      nativeCalls += 1;
      return {
        callId: call.id,
        ok: true,
        output: `native:${String(call.arguments['text'] ?? '')}`,
      };
    },
  };
  const { step, jsCalls, emitted } = makeStep('echo', native);
  await step.run(context);

  assert.strictEqual(nativeCalls, 1, '原生 runTool 应被调用一次');
  assert.strictEqual(jsCalls.count, 0, '原生可用时不应回退 JS');
  const toolResult = emitted.find((e) => e.type === 'tool_result');
  assert.ok(toolResult, '应记录 tool_result 事件');
  assert.strictEqual((toolResult!.payload as { ok: boolean }).ok, true);
  assert.strictEqual((toolResult!.payload as { output?: string }).output, 'native:hi');
});

test('原生后端抛错：自动回退 JS 路径执行（fail-closed，不静默丢弃）', async () => {
  let nativeCalls = 0;
  const native: NativeToolRunner = {
    runTool(): ToolResult {
      nativeCalls += 1;
      throw new Error('内核内部失败');
    },
  };
  const { step, jsCalls, emitted } = makeStep('echo', native);
  await step.run(context);

  assert.strictEqual(nativeCalls, 1, '原生 runTool 应被尝试一次');
  assert.strictEqual(jsCalls.count, 1, '原生失败后必须回退 JS 执行');
  const toolResult = emitted.find((e) => e.type === 'tool_result');
  assert.ok(toolResult, '回退 JS 后应记录 tool_result');
  assert.strictEqual((toolResult!.payload as { output?: string }).output, 'js-ran');
});

test('原生业务拒绝（rejected）：记录为 denied，不回退 JS', async () => {
  let nativeCalls = 0;
  const native: NativeToolRunner = {
    runTool(call: ToolCall): ToolResult {
      nativeCalls += 1;
      return { callId: call.id, ok: false, error: '命中危险命令规则' };
    },
  };
  const { step, jsCalls, emitted } = makeStep('shell.run', native);
  await step.run(context);

  assert.strictEqual(nativeCalls, 1);
  assert.strictEqual(jsCalls.count, 0, '业务拒绝不应触发 JS 回退');
  const toolResult = emitted.find((e) => e.type === 'tool_result');
  assert.ok(toolResult, '应记录 tool_result');
  assert.strictEqual((toolResult!.payload as { ok: boolean }).ok, false);
  assert.strictEqual((toolResult!.payload as { error?: string }).error, '命中危险命令规则');
});

test('native 未注入时：走原有 JS 路径', async () => {
  const { step, jsCalls, emitted } = makeStep('echo');
  await step.run(context);

  assert.strictEqual(jsCalls.count, 1, '无原生后端时应走 JS');
  const toolResult = emitted.find((e) => e.type === 'tool_result');
  assert.ok(toolResult);
  assert.strictEqual((toolResult!.payload as { output?: string }).output, 'js-ran');
});

test('NativeBackend.tryCreate 不抛错（可用返回后端，不可用返回 undefined）', () => {
  // 不依赖具体内核状态：仅断言返回值是后端或 undefined，且后端具备 runTool。
  const backend = NativeBackend.tryCreate();
  if (backend !== undefined) {
    assert.strictEqual(typeof backend.runTool, 'function');
  }
});
