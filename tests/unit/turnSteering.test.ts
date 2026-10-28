/**
 * A8：回合中 steering 在**步边界**注入（2026-10-29）。
 *
 * 约束：绝不能插进 `assistant(tool_calls) ↔ tool` 中间，否则上游 400；
 * 本判据断言顺序为 tool_result → user(steering) → 下一轮请求。
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

test('steer：步边界注入，不打断工具配对；下一轮模型能看到追加指令', async () => {
  const prompts: string[] = [];
  let call = 0;
  const model: ModelPort = {
    name: 'mock',
    generate: async (request: ModelRequest): Promise<ModelOutput> => {
      const last = [...request.messages].reverse().find((message) => message.role === 'user');
      prompts.push(typeof last?.content === 'string' ? last.content : '');
      call += 1;
      if (call === 1) {
        return { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] };
      }
      return { text: '已按新方向完成' };
    },
  };
  const tools: ToolPort = {
    name: 'js',
    list: () => [
      { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
    ],
    execute: async (c) => ({ callId: c.id, ok: true, output: 'body' }),
  };
  const sessionId = 's-steer';
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
  let steered = false;
  const runner = new TurnRunner(
    stepRunner,
    recorder,
    4,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    0,
    () => {
      if (steered) return undefined;
      steered = true;
      return '改方向：先别读 a.ts，去看 b.ts';
    },
  );
  const outcome = await runner.run({ sessionId, workspaceRoot: '/tmp' });

  assert.strictEqual(outcome.steps, 2, 'steering 后应再跑一步');
  assert.strictEqual(outcome.finalText, '已按新方向完成');
  assert.ok(
    prompts[1]?.includes('改方向'),
    `下一轮请求必须包含 steering 文本，实际: ${prompts[1] ?? ''}`,
  );
  const events = recorder.allEvents();
  const resultAt = events.findIndex((event) => event.type === 'tool_result');
  const steerAt = events.findIndex(
    (event) =>
      event.type === 'user' &&
      String((event.payload as { content?: unknown }).content ?? '').includes('改方向'),
  );
  assert.ok(resultAt >= 0 && steerAt > resultAt, 'steering 必须在 tool_result 之后注入');
});
