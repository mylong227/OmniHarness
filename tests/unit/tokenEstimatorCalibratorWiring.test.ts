/** CTX-02：token 校准器接入请求路径与压缩阈值（2026-10-21）。 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ContextCompactor } from '../../src/context/contextCompactor.ts';
import { TokenEstimatorCalibrator } from '../../src/context/tokenEstimatorCalibrator.ts';
import { StepRunner } from '../../src/core/stepRunner.ts';
import { SessionRecorder } from '../../src/core/sessionRecorder.ts';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import { RepoMapContextEngine } from '../../src/context/repoMap/repoMapContextEngine.ts';
import type { ModelPort } from '../../src/ports/model/model.ts';
import type { ApprovalPort } from '../../src/ports/runtime/approval.ts';
import type { SandboxPort } from '../../src/ports/runtime/sandbox.ts';
import type { ToolPort } from '../../src/ports/tool/tool.ts';

function feed(calibrator: TokenEstimatorCalibrator, times: number, factor: number): void {
  for (let i = 0; i < times; i += 1) {
    calibrator.observe({ estimated: 100, actual: 100 * factor });
  }
}

test('压缩器：校准器样本 ≥5 且实际偏大时提前压缩', async () => {
  const messages = [
    { role: 'system' as const, content: 'SYS' },
    ...Array.from({ length: 6 }, (_unused, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: 'x'.repeat(400),
    })),
  ];
  const uncalibrated = new ContextCompactor(undefined, {
    maxTokens: 1000,
    keepRecent: 2,
    contextWindowTokens: 1000,
  });
  const calibrated = new ContextCompactor(undefined, {
    maxTokens: 1000,
    keepRecent: 2,
    contextWindowTokens: 1000,
    calibrator: (() => {
      const calibrator = new TokenEstimatorCalibrator();
      feed(calibrator, 5, 1.5);
      return calibrator;
    })(),
  });
  const plain = await uncalibrated.compact(messages);
  const adjusted = await calibrated.compact(messages);
  assert.strictEqual(plain.compacted, false, '未校准：600 token < 800 阈值，不应压缩');
  assert.strictEqual(adjusted.compacted, true, '校准 factor=1.5：阈值降到 533，必须压缩');
});

test('StepRunner：模型 usage 会喂给注入的校准器', async () => {
  const calibrator = new TokenEstimatorCalibrator();
  const recorder = new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), 'cal');
  recorder.user('请回答');
  const model: ModelPort = {
    name: 'usage-model',
    generate: async () => ({
      text: 'ok',
      finishReason: 'stop',
      usage: { promptTokens: 900, completionTokens: 10, totalTokens: 910 },
    }),
  };
  const tools: ToolPort = {
    name: 'none',
    list: () => [],
    execute: async (call) => ({ callId: call.id, ok: true, output: '' }),
  };
  const approvals: ApprovalPort = { name: 'allow', decide: async () => 'allow' };
  const sandbox: SandboxPort = { name: 'ok', check: async () => ({ allowed: true }) };
  const runner = new StepRunner({
    model,
    tools,
    approvals,
    sandbox,
    repoMapContext: new RepoMapContextEngine(),
    recorder,
    sessionId: 'cal',
    calibrator,
  });
  await runner.run({ sessionId: 'cal', workspaceRoot: '/tmp' });
  assert.strictEqual(calibrator.report().samples, 1);
  assert.ok(calibrator.report().factor > 0);
});
