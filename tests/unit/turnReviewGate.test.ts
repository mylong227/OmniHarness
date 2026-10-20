import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TurnRunner } from '../../src/core/turnRunner.ts';
import { SessionRecorder } from '../../src/core/sessionRecorder.ts';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import type { StepRunner } from '../../src/core/stepRunner.ts';
import type { TurnDiffTrackerPort } from '../../src/ports/runtime/turnDiffTracker.ts';
import type { ReviewPort } from '../../src/ports/tool/review.ts';

test('VER-06：reviewer 报 major 时回灌一次，且每回合至多一次', async () => {
  const recorder = new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), 's1');
  recorder.user('修 bug');
  let stepCalls = 0;
  const stepRunner = {
    usageOfLastStep: 0,
    run: async () => {
      stepCalls += 1;
      recorder.assistant('改好了');
      return 'text';
    },
    finalize: async () => '兜底',
  } as unknown as StepRunner;
  let reviewCalls = 0;
  const reviewer: ReviewPort = {
    review: async () => {
      reviewCalls += 1;
      return {
        ok: true,
        findings: [
          { severity: 'major', file: 'src/a.ts', line: 3, issue: '边界漏判', evidence: '空数组' },
        ],
        raw: '',
      };
    },
  };
  const turnDiff = {
    getUnifiedDiff: () => '--- a/src/a.ts\n+++ b/src/a.ts',
    reset: () => {},
  } as unknown as TurnDiffTrackerPort;
  const runner = new TurnRunner(
    stepRunner,
    recorder,
    5,
    turnDiff,
    undefined,
    undefined,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    undefined,
    reviewer,
    true,
  );
  const outcome = await runner.run({ sessionId: 's1', workspaceRoot: '/tmp' });
  assert.strictEqual(stepCalls, 2, '阻断后应再给一步');
  assert.strictEqual(reviewCalls, 1, 'reviewer 每回合至多一次');
  assert.ok(
    recorder.allEvents().some((event) => {
      if (event.type !== 'user') return false;
      return String((event.payload as { content?: string }).content).includes('独立审查');
    }),
    '应回灌独立审查摘要',
  );
  assert.strictEqual(outcome.truncated, false);
});
