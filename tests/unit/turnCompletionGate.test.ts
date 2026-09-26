/**
 * 回合**完成闸门**回归（2026-09-26 审计 A1）。
 *
 * 缺陷现场：自验证回环只是**信号** —— 它把「改动源码后测试没过」的摘要追加进工具结果，
 * 但产品路径上没有任何东西阻止模型无视它、直接输出结论收尾。于是「改坏了代码还宣布完成」
 * 是**可以发生且不会被拦**的。
 *
 * 本用例钉住闸门的三条不变量：
 *  1. 最近一次自验证失败时，模型声明「完成」会被回灌 + 再给一步（且只给一次）；
 *  2. 最近一次验证通过（或无失败记录）时，闸门**不介入**（正常收敛零行为变更）；
 *  3. 闸门不伪造内容：最终文本仍来自模型。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StepRunner } from '../../src/core/stepRunner.js';
import { TurnRunner, type CompletionGate } from '../../src/core/turnRunner.js';
import { SessionRecorder } from '../../src/core/sessionRecorder.js';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import type { ModelPort, ModelOutput, ModelRequest } from '../../src/ports/model/model.js';
import type { ToolPort } from '../../src/ports/tool/tool.js';
import type { ApprovalPort } from '../../src/ports/runtime/approval.js';
import type { SandboxPort } from '../../src/ports/runtime/sandbox.js';
import { RepoMapContextEngine } from '../../src/context/repoMapContextEngine.js';

const allowApproval: ApprovalPort = { name: 'allow', decide: async () => 'allow' };
const sandboxOk: SandboxPort = { name: 'ok', check: async () => ({ allowed: true }) };
const tools: ToolPort = {
  name: 'js',
  list: () => [
    { name: 'edit', description: 'edit', parameters: { type: 'object', properties: {} } },
  ],
  execute: async (c) => ({ callId: c.id, ok: true, output: 'ok' }),
};

/** 构造「模型直接输出文本收尾」的模型桩。 */
function textModel(texts: readonly string[]): { model: ModelPort; prompts: string[] } {
  let i = 0;
  const prompts: string[] = [];
  const model: ModelPort = {
    name: 'mock',
    generate: async (req: ModelRequest): Promise<ModelOutput> => {
      const last = req.messages.filter((m) => m.role === 'user').at(-1);
      prompts.push(typeof last?.content === 'string' ? last.content : '');
      const text = texts[Math.min(i, texts.length - 1)] ?? '完成';
      i += 1;
      return { text };
    },
  };
  return { model, prompts };
}

/** 构造一次回合执行器。 */
function build(
  sessionId: string,
  model: ModelPort,
  maxSteps: number,
  gate?: CompletionGate,
): { runner: TurnRunner; recorder: SessionRecorder } {
  const recorder = new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), sessionId);
  const sr = new StepRunner({
    model,
    tools,
    approvals: allowApproval,
    sandbox: sandboxOk,
    repoMapContext: new RepoMapContextEngine(),
    recorder,
    sessionId,
  });
  const runner =
    gate === undefined
      ? new TurnRunner(sr, recorder, maxSteps)
      : new TurnRunner(
          sr,
          recorder,
          maxSteps,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          0,
          gate,
        );
  return { runner, recorder };
}

test('A1：最近一次自验证失败 ⇒ 模型说「完成」被闸门拦下并再给一步（只给一次）', async () => {
  const { model, prompts } = textModel(['我改好了。', '已按闸门提示修复。']);
  const gate: CompletionGate = { lastFailure: () => '[自验证回环] 测试未通过（exit=1）：3 failed' };
  const { runner, recorder } = build('s-a1-1', model, 6, gate);
  const outcome = await runner.run({ sessionId: 's-a1-1', workspaceRoot: '/tmp' });

  assert.strictEqual(outcome.steps, 2, '应被闸门多给一步（7→2 步后收敛）');
  assert.strictEqual(outcome.finalText, '已按闸门提示修复。', '最终文本仍来自模型');
  assert.ok(
    prompts.some((p) => p.includes('完成闸门')),
    '回灌消息必须包含闸门提示',
  );
  assert.ok(
    prompts.some((p) => p.includes('3 failed')),
    '回灌消息必须带上真实失败摘要（模型要据此修复）',
  );
  assert.ok(
    recorder
      .allEvents()
      .some(
        (e) =>
          e.type === 'user' &&
          String((e.payload as { content?: unknown }).content ?? '').includes('完成闸门'),
      ),
    '闸门注入应落在事件流里（UI/审计可见）',
  );
});

test('A1：闸门每回合至多触发一次（模型第二次仍说完成就放行，不死循环）', async () => {
  const { model } = textModel(['我改好了。', '我坚持完成。', '我不会被用到。']);
  const gate: CompletionGate = { lastFailure: () => '测试未通过' };
  const { runner } = build('s-a1-2', model, 8, gate);
  const outcome = await runner.run({ sessionId: 's-a1-2', workspaceRoot: '/tmp' });
  assert.strictEqual(outcome.steps, 2, '只多给一步');
  assert.strictEqual(outcome.finalText, '我坚持完成。');
});

test('A1：最近一次验证通过（无失败记录）⇒ 闸门不介入，正常收敛零行为变更', async () => {
  const { model, prompts } = textModel(['一次到位。']);
  const gate: CompletionGate = { lastFailure: () => undefined };
  const { runner } = build('s-a1-3', model, 6, gate);
  const outcome = await runner.run({ sessionId: 's-a1-3', workspaceRoot: '/tmp' });
  assert.strictEqual(outcome.steps, 1, '不应多给步');
  assert.strictEqual(outcome.finalText, '一次到位。');
  assert.ok(!prompts.some((p) => p.includes('完成闸门')), '不得注入闸门提示');
});

test('A1：未注入闸门 ⇒ 与改造前逐字一致（零行为变更）', async () => {
  const { model } = textModel(['没有闸门的旧行为。']);
  const { runner } = build('s-a1-4', model, 6);
  const outcome = await runner.run({ sessionId: 's-a1-4', workspaceRoot: '/tmp' });
  assert.strictEqual(outcome.steps, 1);
  assert.strictEqual(outcome.finalText, '没有闸门的旧行为。');
});
