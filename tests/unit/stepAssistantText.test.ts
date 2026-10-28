/**
 * 同一步「文本 + 工具调用」：文本必须落事件流并回灌（2026-10-28）。
 *
 * 缺陷现场：`StepRunner.run` 在 toolCalls 分支直接执行工具，`output.text` 从未记录；
 * 模型的计划/判断（"先改 A 再跑测试"）在历史、压缩摘要与复盘里都不存在。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { StepRunner } from '../../src/core/stepRunner.ts';
import { TurnRunner } from '../../src/core/turnRunner.ts';
import { SessionRecorder } from '../../src/core/sessionRecorder.ts';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import type { ModelPort, ModelOutput, ModelRequest } from '../../src/ports/model/model.ts';
import type { ToolPort } from '../../src/ports/tool/tool.ts';
import type { ApprovalPort } from '../../src/ports/runtime/approval.ts';
import type { SandboxPort } from '../../src/ports/runtime/sandbox.ts';
import { RepoMapContextEngine } from '../../src/context/repoMap/repoMapContextEngine.ts';

const allowApproval: ApprovalPort = { name: 'allow', decide: async () => 'allow' };
const sandboxOk: SandboxPort = { name: 'ok', check: async () => ({ allowed: true }) };

test('同一步的 assistant 文本先落事件流，并在下一轮请求里回灌', async () => {
  const requests: ModelRequest[] = [];
  let step = 0;
  const model: ModelPort = {
    name: 'mock',
    generate: async (req: ModelRequest): Promise<ModelOutput> => {
      requests.push(req);
      step += 1;
      if (step === 1) {
        return {
          text: '先读文件再改',
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }],
        };
      }
      return { text: '完成' };
    },
  };
  const tools: ToolPort = {
    name: 'js',
    list: () => [
      { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
    ],
    execute: async (c) => ({ callId: c.id, ok: true, output: 'file body' }),
  };
  const sessionId = 's-assistant-text';
  const recorder = new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), sessionId);
  const stepRunner = new StepRunner({
    model,
    tools,
    approvals: allowApproval,
    sandbox: sandboxOk,
    repoMapContext: new RepoMapContextEngine(),
    recorder,
    sessionId,
  });
  const runner = new TurnRunner(stepRunner, recorder, 4);
  await runner.run({ sessionId, workspaceRoot: '/tmp' });

  const events = recorder.allEvents();
  const textAt = events.findIndex(
    (event) =>
      event.type === 'assistant' &&
      String((event.payload as { content?: unknown }).content ?? '') === '先读文件再改',
  );
  const callAt = events.findIndex((event) => event.type === 'tool_call');
  assert.ok(textAt >= 0, 'assistant 文本必须落事件流');
  assert.ok(callAt > textAt, '文本应排在 tool_call 之前');

  const second = requests[1]?.messages ?? [];
  assert.ok(
    second.some((message) => message.role === 'assistant' && message.content === '先读文件再改'),
    '下一轮请求必须带上该文本',
  );
  assert.ok(
    second.some((message) => message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0),
    '工具调用消息仍必须在（配对不变量）',
  );
});
