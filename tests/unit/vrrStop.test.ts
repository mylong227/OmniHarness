/**
 * U2-2 **VRR-Stop**（验证-修复停止规则，2026-10-30）回归。
 *
 * 缺口：完成闸门验证失败 ⇒ 回灌「再修」并再给一步——这条回环隐含假设「再修有边际增益」，
 * 但同一失败签名跨回合重复出现时，继续修大概率原地打转（arXiv:2607.17641：验证器与修复器
 * 都有噪声时继续修会破坏本来正确的产物）。停止规则：同签名 ⇒ 停止注入、如实记 `failed`；
 * 不同签名 ⇒ 允许下一轮。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { StepRunner } from '../../src/kernel/core/stepRunner.ts';
import { TurnRunner, type CompletionGate } from '../../src/kernel/core/turnRunner.ts';
import { TurnFailureLedger } from '../../src/kernel/core/turnFailureLedger.ts';
import { SessionRecorder } from '../../src/kernel/core/sessionRecorder.ts';
import { AppendOnlyEventLog } from '../../src/kernel/core/appendOnlyEventLog.ts';
import { SilentEventPort } from '../../src/kernel/adapters/event/silentEventPort.ts';
import type { ModelPort, ModelOutput, ModelRequest } from '../../src/contracts/ports/model/model.ts';
import type { ToolPort } from '../../src/contracts/ports/tool/tool.ts';
import type { ApprovalPort } from '../../src/contracts/ports/runtime/approval.ts';
import type { SandboxPort } from '../../src/contracts/ports/runtime/sandbox.ts';
import { RepoMapContextEngine } from '../../src/kernel/context/repoMap/repoMapContextEngine.ts';

const allowApproval: ApprovalPort = { name: 'allow', decide: async () => 'allow' };
const sandboxOk: SandboxPort = { name: 'ok', check: async () => ({ allowed: true }) };
const tools: ToolPort = {
  name: 'js',
  list: () => [
    { name: 'edit', description: 'edit', parameters: { type: 'object', properties: {} } },
  ],
  execute: async (c) => ({ callId: c.id, ok: true, output: 'ok' }),
};

/** 模型桩：按序吐文本；记录每步最后一条 user 消息（可见回灌）。 */
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

/** 构造一回合执行器（多 TurnRunner 共享同一台账以模拟跨回合）。 */
function build(
  sessionId: string,
  model: ModelPort,
  ledger: TurnFailureLedger,
  gate: CompletionGate,
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
  const runner = new TurnRunner(
    sr,
    recorder,
    8,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    0,
    gate,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    0,
    undefined,
    ledger,
  );
  return { runner, recorder };
}

test('VRR-Stop：同签名重复 ⇒ 第二回合不再回灌「再修」，如实记 failed', async () => {
  const ledger = new TurnFailureLedger();
  const digest = '[完成闸门] 回合结束验证未通过（exit=1）：npm test\n  ✗ a.test.ts 期望 2 得 3';
  const gate: CompletionGate = { kind: 'status', verify: async () => digest };

  // 回合 1：首次失败 ⇒ 注入「再修」并多给一步（既有行为不变）。
  const turn1 = textModel(['我改好了。', '按提示修了。']);
  const r1 = build('s-vrr-1', turn1.model, ledger, gate);
  const o1 = await r1.runner.run({ sessionId: 's-vrr-1', workspaceRoot: '/tmp' });
  assert.strictEqual(o1.steps, 2, '首回合仍回灌再给一步');
  assert.ok(
    turn1.prompts.some((p) => p.includes('完成闸门')),
    '首回合必须注入失败摘要',
  );
  assert.strictEqual(o1.verificationState, 'unverified', '回合内二次宣告仍按既有口径');

  // 回合 2：同签名再次失败 ⇒ VRR-Stop 停止回灌，立即收尾。
  const turn2 = textModel(['我又改好了。']);
  const r2 = build('s-vrr-1', turn2.model, ledger, gate);
  const o2 = await r2.runner.run({ sessionId: 's-vrr-1', workspaceRoot: '/tmp' });
  assert.strictEqual(o2.steps, 1, '同签名失败不应再多给步');
  assert.strictEqual(o2.finalText, '我又改好了。');
  assert.ok(!turn2.prompts.some((p) => p.includes('完成闸门')), '同签名重复时不得再注入「再修」');
  assert.strictEqual(o2.verificationState, 'failed', '如实记 failed（核验确实未通过）');
  assert.ok(
    r2.recorder
      .allEvents()
      .some(
        (e) =>
          e.type === 'system' &&
          String((e.payload as { content?: unknown }).content ?? '').includes('VRR-Stop'),
      ),
    '止损决定必须留痕（system 事件）',
  );
});

test('VRR-Stop：不同签名 ⇒ 仍回灌并再给一步', async () => {
  const ledger = new TurnFailureLedger();
  const failures = [
    '[完成闸门] 回合结束验证未通过（exit=1）：npm test\n  ✗ a.test.ts 期望 2 得 3',
    '[完成闸门] 回合结束验证未通过（exit=2）：npm run build\n  ✗ 类型错误 b.ts:10',
  ];
  let calls = 0;
  const gate: CompletionGate = {
    kind: 'status',
    verify: async () => failures[Math.min(calls++, failures.length - 1)],
  };

  const turn1 = textModel(['改好了。', '按第一个错误修了。']);
  const r1 = build('s-vrr-2', turn1.model, ledger, gate);
  await r1.runner.run({ sessionId: 's-vrr-2', workspaceRoot: '/tmp' });

  const turn2 = textModel(['这次真改好了。', '又修了一处。']);
  const r2 = build('s-vrr-2', turn2.model, ledger, gate);
  const o2 = await r2.runner.run({ sessionId: 's-vrr-2', workspaceRoot: '/tmp' });
  assert.strictEqual(o2.steps, 2, '签名变了 ⇒ 允许下一轮（回灌再给一步）');
  assert.ok(
    turn2.prompts.some((p) => p.includes('类型错误')),
    '新签名必须作为新摘要回灌',
  );
});

test('TurnFailureLedger：归一化（空白折叠 + 大小写）后同签名命中', () => {
  const ledger = new TurnFailureLedger();
  const sessionId = 's-ledger';
  ledger.record(
    sessionId,
    ledger.signatureOf('验证未通过（exit=1）：\n  ✗ A.test.ts\t  期望 2 得 3'),
  );

  assert.strictEqual(
    ledger.sameAsLast(
      sessionId,
      ledger.signatureOf('验证未通过（exit=1）：\n✗ a.test.ts 期望 2 得 3'),
    ),
    true,
    '空白/大小写差异不改变签名',
  );
  assert.strictEqual(
    ledger.sameAsLast(sessionId, ledger.signatureOf('验证未通过（exit=2）')),
    false,
    '不同失败内容签名不同',
  );
  assert.strictEqual(
    ledger.sameAsLast('s-other', ledger.signatureOf('验证未通过（exit=1）')),
    false,
    '跨会话互不影响',
  );
});

test('TurnFailureLedger：会话表有界（512 上限，淘汰最旧）', () => {
  const ledger = new TurnFailureLedger();
  const first = 's-first';
  ledger.record(first, ledger.signatureOf('fail-1'));
  for (let i = 0; i < 600; i += 1) {
    ledger.record(`s-${String(i)}`, ledger.signatureOf(`fail-${String(i)}`));
  }
  assert.strictEqual(
    ledger.sameAsLast(first, ledger.signatureOf('fail-1')),
    false,
    '最旧的会话记录应被淘汰（不 grows unbounded）',
  );
});
