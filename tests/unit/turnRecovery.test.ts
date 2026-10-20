/**
 * 长时执行恢复判据（LR-02 / LR-04，2026-10-20）。
 *
 * 口径：这是**能力验收**，不是跑分——验证“截断续写/过载切换”这条路径存在且可观察。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { StepRunner } from '../../src/core/stepRunner.ts';
import { SessionRecorder } from '../../src/core/sessionRecorder.ts';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import { RepoMapContextEngine } from '../../src/context/repoMap/repoMapContextEngine.ts';
import { ModelCallError } from '../../src/errors/modelCallError.ts';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.ts';
import type { ApprovalPort } from '../../src/ports/runtime/approval.ts';
import type { SandboxPort } from '../../src/ports/runtime/sandbox.ts';
import type { ToolPort } from '../../src/ports/tool/tool.ts';

function recorderFor(sessionId: string): SessionRecorder {
  return new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), sessionId);
}

const allowApproval: ApprovalPort = { name: 'allow', decide: async () => 'allow' };
const sandboxOk: SandboxPort = { name: 'ok', check: async () => ({ allowed: true }) };
const noTools: ToolPort = {
  name: 'none',
  list: () => [],
  execute: async (c) => ({ callId: c.id, ok: true, output: '' }),
};

function runnerFor(model: ModelPort, recorder: SessionRecorder, fallbackModel?: ModelPort) {
  return new StepRunner({
    model,
    tools: noTools,
    approvals: allowApproval,
    sandbox: sandboxOk,
    repoMapContext: new RepoMapContextEngine(),
    recorder,
    sessionId: 's',
    ...(fallbackModel !== undefined ? { fallbackModel } : {}),
  });
}

test('LR-02：finishReason=length 触发续写并合并文本（≤3 次）', async () => {
  const recorder = recorderFor('lr02');
  const requests: ModelRequest[] = [];
  let call = 0;
  const model: ModelPort = {
    name: 'scripted',
    generate: async (request) => {
      requests.push(request);
      call += 1;
      if (call === 1) return { text: '前半段。', finishReason: 'length' };
      return { text: '后半段。', finishReason: 'stop' };
    },
  };
  const outcome = await runnerFor(model, recorder).run({
    sessionId: 'lr02',
    workspaceRoot: '/tmp',
  });
  assert.strictEqual(outcome, 'text');
  assert.strictEqual(call, 2, '截断后必须再请求一次续写');
  assert.strictEqual(recorder.lastAssistantText(), '前半段。后半段。');
  assert.ok(
    requests[1]?.messages.some((m) => m.role === 'user' && m.content.includes('Resume directly')),
    '续写请求必须带续写指令',
  );
  assert.ok(
    recorder
      .allEvents()
      .some(
        (e) =>
          e.type === 'system' &&
          String((e.payload as { content?: string }).content).includes('输出截断'),
      ),
    '续写必须留可见事件',
  );
});

test('LR-02：续写次数用尽仍截断时，不执行半截工具调用', async () => {
  const recorder = recorderFor('lr02b');
  const model: ModelPort = {
    name: 'always-truncated',
    generate: async () => ({
      text: '半截',
      finishReason: 'length',
      toolCalls: [{ id: 'c1', name: 'write_file', arguments: {} }],
    }),
  };
  const outcome = await runnerFor(model, recorder).run({
    sessionId: 'lr02b',
    workspaceRoot: '/tmp',
  });
  assert.strictEqual(outcome, 'text', '不应把半截 tool_calls 当成功工具步');
  assert.strictEqual(recorder.allEvents().filter((e) => e.type === 'tool_result').length, 0);
});

test('LR-02：Anthropic 的 max_tokens 也触发续写（2026-10-21 回归）', async () => {
  const recorder = recorderFor('lr02-anthropic');
  let call = 0;
  const model: ModelPort = {
    name: 'anthropic-shape',
    generate: async () => {
      call += 1;
      if (call === 1) return { text: '前半段。', finishReason: 'max_tokens' };
      return { text: '后半段。', finishReason: 'end_turn' };
    },
  };
  const outcome = await runnerFor(model, recorder).run({
    sessionId: 'lr02-anthropic',
    workspaceRoot: '/tmp',
  });
  assert.strictEqual(outcome, 'text');
  assert.strictEqual(call, 2, 'max_tokens 必须触发续写，而不是按完成收尾');
  assert.strictEqual(recorder.lastAssistantText(), '前半段。后半段。');
});

test('LR-02：Anthropic 的 max_tokens 用尽后同样不执行半截工具调用', async () => {
  const recorder = recorderFor('lr02-anthropic-tool');
  const model: ModelPort = {
    name: 'anthropic-shape',
    generate: async () => ({
      text: '半截',
      finishReason: 'max_tokens',
      toolCalls: [{ id: 'c1', name: 'write_file', arguments: {} }],
    }),
  };
  const outcome = await runnerFor(model, recorder).run({
    sessionId: 'lr02-anthropic-tool',
    workspaceRoot: '/tmp',
  });
  assert.strictEqual(outcome, 'text');
  assert.strictEqual(recorder.allEvents().filter((e) => e.type === 'tool_result').length, 0);
});

test('LR-04：主模型 529 后切换到备用模型重试', async () => {
  const recorder = recorderFor('lr04');
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primary: ModelPort = {
    name: 'primary',
    generate: async () => {
      primaryCalls += 1;
      throw new ModelCallError('overloaded', { status: 529, retryable: true });
    },
  };
  const fallback: ModelPort = {
    name: 'fallback',
    generate: async (): Promise<ModelOutput> => {
      fallbackCalls += 1;
      return { text: '备用模型完成', finishReason: 'stop' };
    },
  };
  const outcome = await runnerFor(primary, recorder, fallback).run({
    sessionId: 'lr04',
    workspaceRoot: '/tmp',
  });
  assert.strictEqual(outcome, 'text');
  assert.strictEqual(primaryCalls, 1);
  assert.strictEqual(fallbackCalls, 1);
  assert.strictEqual(recorder.lastAssistantText(), '备用模型完成');
  assert.ok(
    recorder
      .allEvents()
      .some(
        (e) =>
          e.type === 'system' &&
          String((e.payload as { content?: string }).content).includes('模型过载'),
      ),
    '切换必须留可见事件',
  );
});
