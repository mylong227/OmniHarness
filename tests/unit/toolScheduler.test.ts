import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolScheduler } from '../../src/core/loop/toolScheduler.js';
import type { ToolCall, ToolResult } from '../../src/ports/tool/tool.js';

function makeCall(id: string, name: string): ToolCall {
  return { id, name, arguments: {} };
}

function ok(call: ToolCall, output = 'done'): ToolResult {
  return { callId: call.id, ok: true, output };
}

/** 记录并发度的执行器：验证并行批确实并发。 */
function concurrencyRecorder(maxObserved: { value: number }, inflight = { value: 0 }) {
  return async (call: ToolCall): Promise<ToolResult> => {
    inflight.value += 1;
    maxObserved.value = Math.max(maxObserved.value, inflight.value);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inflight.value -= 1;
    return ok(call);
  };
}

test('ToolScheduler：连续只读调用并行执行（并发度 > 1）', async () => {
  const scheduler = new ToolScheduler({ maxParallel: 8 });
  const calls = ['r1', 'r2', 'r3', 'r4'].map((id) => makeCall(id, 'read_file'));
  const maxObserved = { value: 0 };
  const results = await scheduler.run(calls, concurrencyRecorder(maxObserved));
  assert.ok(maxObserved.value > 1, `期望并发执行，实测最大并发 ${maxObserved.value}`);
  assert.strictEqual(results.length, 4);
  // model-order 保持
  assert.deepStrictEqual(
    results.map((r) => r.call.id),
    ['r1', 'r2', 'r3', 'r4'],
  );
});

test('ToolScheduler：写类调用形成屏障（与读类不并行）', async () => {
  const scheduler = new ToolScheduler({ maxParallel: 8 });
  const calls = [
    makeCall('r1', 'read_file'),
    makeCall('w1', 'write_file'),
    makeCall('r2', 'read_file'),
  ];
  const events: string[] = [];
  const results = await scheduler.run(calls, async (call) => {
    events.push(`start:${call.id}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push(`end:${call.id}`);
    return ok(call);
  });
  assert.strictEqual(results.length, 3);
  // 屏障语义：r2 的 start 必须在 w1 的 end 之后（读类不会跨越写类并行）。
  const w1End = events.indexOf('end:w1');
  const r2Start = events.indexOf('start:r2');
  assert.ok(w1End >= 0 && r2Start > w1End, `写屏障被破坏: ${events.join(', ')}`);
});

test('ToolScheduler：单工具抛异常转为 failed ToolResult，不连累同批', async () => {
  const scheduler = new ToolScheduler();
  const calls = [makeCall('a', 'read_file'), makeCall('b', 'read_file')];
  const results = await scheduler.run(calls, async (call) => {
    if (call.id === 'a') {
      throw new Error('boom');
    }
    return ok(call);
  });
  assert.strictEqual(results[0]?.result.ok, false);
  assert.strictEqual(results[0]?.result.error, 'boom');
  assert.strictEqual(results[1]?.result.ok, true);
});

test('ToolScheduler：maxParallel 有界并发', async () => {
  const scheduler = new ToolScheduler({ maxParallel: 2 });
  const calls = Array.from({ length: 6 }, (_v, i) => makeCall(`r${i}`, 'grep'));
  const maxObserved = { value: 0 };
  await scheduler.run(calls, concurrencyRecorder(maxObserved));
  assert.ok(maxObserved.value <= 2, `期望并发 ≤2，实测 ${maxObserved.value}`);
});

test('ToolScheduler：默认策略把 bash/shell/subagent 视为串行', async () => {
  const scheduler = new ToolScheduler();
  const calls = [makeCall('r', 'read_file'), makeCall('s', 'bash')];
  const maxObserved = { value: 0 };
  await scheduler.run(calls, concurrencyRecorder(maxObserved));
  // bash 屏障把 read_file 隔开：任意时刻并发 ≤1
  assert.strictEqual(maxObserved.value, 1);
});

// ---- 2026-09-22 回归（审计 P2）：写类屏障必须覆盖 MUTATING_TOOLS 全集，而不是名字子串 ----
test('ToolScheduler：rollback / checkpoint / remember 均形成屏障（此前被判为可并行）', async () => {
  for (const name of ['rollback', 'checkpoint', 'remember']) {
    const scheduler = new ToolScheduler({ maxParallel: 8 });
    const calls = [makeCall('r1', 'read_file'), makeCall('w', name), makeCall('r2', 'read_file')];
    const events: string[] = [];
    await scheduler.run(calls, async (call) => {
      events.push(`start:${call.id}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(`end:${call.id}`);
      return ok(call);
    });
    const wEnd = events.indexOf('end:w');
    const r2Start = events.indexOf('start:r2');
    assert.ok(wEnd >= 0 && r2Start > wEnd, `${name} 未形成写屏障: ${events.join(', ')}`);
  }
});

test('ToolScheduler：写类与写类之间也串行（rollback + remember 不同批并发）', async () => {
  const scheduler = new ToolScheduler({ maxParallel: 8 });
  const calls = [makeCall('a', 'rollback'), makeCall('b', 'remember')];
  const maxObserved = { value: 0 };
  await scheduler.run(calls, concurrencyRecorder(maxObserved));
  assert.strictEqual(maxObserved.value, 1, '两个写类工具不得并行');
});

test('MUTATING_TOOLS 是单一口径：调度器与门禁对同一集合判定', async () => {
  const { MUTATING_TOOLS } = await import('../../src/core/toolGate.js');
  const scheduler = new ToolScheduler({ maxParallel: 8 });
  for (const name of MUTATING_TOOLS) {
    const calls = [makeCall('r', 'read_file'), makeCall('w', name)];
    const maxObserved = { value: 0 };
    await scheduler.run(calls, concurrencyRecorder(maxObserved));
    assert.strictEqual(maxObserved.value, 1, `${name} 在 MUTATING_TOOLS 内却可并行（口径漂移）`);
  }
});
