import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { TurnRunner } from '../../src/core/turnRunner.js';
import type { StepOutcome } from '../../src/core/stepRunner.js';
import type { ModelUsage } from '../../src/ports/model/model.js';
import { BudgetExceededError } from '../../src/ports/model/model.js';
import { ConsoleLiveView } from '../../src/adapters/live/consoleLiveView.js';
import { CompositeLiveView } from '../../src/adapters/live/compositeLiveView.js';
import type { ToolInputDelta } from '../../src/ports/model/model.js';

/** 假记录器：仅实现 TurnRunner 用到的面。 */
function fakeRecorder() {
  const systems: string[] = [];
  const users: string[] = [];
  return {
    systems,
    users,
    markTurnStart: () => {},
    system: (text: string) => systems.push(text),
    user: (text: string) => users.push(text),
    lastAssistantText: (): string | undefined => undefined,
    allEvents: () => [],
    sessionId: () => 'sess-test',
    turnDiff: (_d: string) => {},
  };
}

/** 假步进器：脚本化每步 outcome + usage。 */
function fakeStepRunner(
  script: Array<{ outcome: StepOutcome; usage?: ModelUsage }>,
  opts?: {
    throwOnStep?: () => unknown;
  },
) {
  let step = -1;
  return {
    run: async (): Promise<StepOutcome> => {
      step += 1;
      if (opts?.throwOnStep !== undefined) {
        throw opts.throwOnStep();
      }
      return script[Math.min(step, script.length - 1)]?.outcome ?? 'text';
    },
    get usageOfLastStep(): ModelUsage | undefined {
      return script[Math.min(Math.max(step, 0), script.length - 1)]?.usage;
    },
    toolCallsOfLastStep: [],
    finalize: async () => '【兜底总结】已停止步进。',
  };
}

const usage = (total: number): ModelUsage => ({
  promptTokens: total - 1,
  completionTokens: 1,
  totalTokens: total,
});

test('TurnRunner token 预算：累计 usage 超限即停止步进并记录系统事件', async () => {
  const recorder = fakeRecorder();
  const step = fakeStepRunner([
    { outcome: 'tool', usage: usage(100) },
    { outcome: 'tool', usage: usage(100) },
    { outcome: 'tool', usage: usage(100) },
    { outcome: 'tool', usage: usage(100) },
  ]);
  const runner = new TurnRunner(
    step as never,
    recorder as never,
    10, // maxSteps 充裕，证明是预算而非步数终止
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    250,
  );
  const outcome = await runner.run({} as never);
  assert.strictEqual(outcome.steps, 3); // 100/200/300 —— 第三步累计 300 ≥ 250
  assert.strictEqual(outcome.usageTokens, 300);
  assert.ok(recorder.systems.some((s) => s.includes('预算') && s.includes('250')));
  // 终止后 finalize 兜底产出文本（lastAssistantText 恒 undefined → 走 finalize）。
  assert.strictEqual(outcome.finalText, '【兜底总结】已停止步进。');
});

test('TurnRunner token 预算：budget=0 关闭，不设闸', async () => {
  const recorder = fakeRecorder();
  const step = fakeStepRunner([{ outcome: 'tool', usage: usage(999_999) }]);
  const runner = new TurnRunner(
    step as never,
    recorder as never,
    3,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    0,
  );
  const outcome = await runner.run({} as never);
  assert.strictEqual(outcome.steps, 3);
});

test('TurnRunner 预算熔断：BudgetExceededError 不炸回合，finalize 交付已有进展', async () => {
  const recorder = fakeRecorder();
  const step = fakeStepRunner([], {
    throwOnStep: () =>
      new BudgetExceededError('预算耗尽', { limitUsd: 1, spentUsd: 1.01, model: 'm' }),
  });
  const runner = new TurnRunner(
    step as never,
    recorder as never,
    8,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    0,
  );
  const outcome = await runner.run({} as never);
  assert.strictEqual(outcome.steps, 0);
  assert.strictEqual(outcome.finalText, '【兜底总结】已停止步进。');
  assert.ok(recorder.systems.some((s) => s.includes('预算熔断')));
});

test('TurnRunner：非预算错误照常上抛（不吞）', async () => {
  const recorder = fakeRecorder();
  const step = fakeStepRunner([], { throwOnStep: () => new Error('boom') });
  const runner = new TurnRunner(
    step as never,
    recorder as never,
    4,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    0,
  );
  await assert.rejects(runner.run({} as never), /boom/);
});

test('ConsoleLiveView：注入文本通道才流式，未注入静默', () => {
  const textOut = new PassThrough();
  const chunks: string[] = [];
  textOut.on('data', (c: Buffer) => chunks.push(c.toString()));
  const streaming = new ConsoleLiveView(textOut, textOut);
  streaming.onTextDelta('你好');
  streaming.onTextDelta('，世界');
  const silent = new ConsoleLiveView(textOut);
  silent.onTextDelta('不应出现');
  assert.strictEqual(chunks.join(''), '你好，世界');
});

test('CompositeLiveView：onTextDelta 只转发给声明了能力的子 sink', () => {
  const got: string[] = [];
  const capable = {
    name: 'capable',
    onToolInput: () => {},
    onTextDelta: (t: string) => got.push(t),
  };
  const legacy = { name: 'legacy', onToolInput: () => {} };
  const composite = new CompositeLiveView([capable as never, legacy as never]);
  composite.onTextDelta('x');
  assert.deepStrictEqual(got, ['x']);
});

test('ConsoleLiveView.onToolInput：非 TTY 静默（回归护栏）', () => {
  const out = new PassThrough();
  const chunks: string[] = [];
  out.on('data', (c: Buffer) => chunks.push(c.toString()));
  const view = new ConsoleLiveView(out);
  const delta: ToolInputDelta = { id: '1', name: 'shell', partialJson: '{"cmd"' };
  view.onToolInput(delta);
  assert.strictEqual(chunks.join(''), ''); // PassThrough 无 isTTY → 静默
});
