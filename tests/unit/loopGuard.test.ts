import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard, canonicalArgs } from '../../src/core/loop/loopGuard.js';

function call(name: string, args: Record<string, unknown> = {}) {
  return { name, arguments: args };
}

test('LoopGuard：健康步放行并清零连续计数', () => {
  const guard = new LoopGuard();
  assert.deepStrictEqual(guard.observe({ toolCalls: [call('read_file', { path: 'a.ts' })] }), {
    kind: 'allow',
  });
});

test('LoopGuard：同调用连续重复达上限 → nudge，继续重复 → abort', () => {
  const guard = new LoopGuard({ maxExactRepeats: 3, nudgeLimit: 2 });
  const repeated = [call('grep', { pattern: 'foo', path: 'src' })];
  assert.deepStrictEqual(guard.observe({ toolCalls: repeated }), { kind: 'allow' });
  assert.deepStrictEqual(guard.observe({ toolCalls: repeated }), { kind: 'allow' });
  const first = guard.observe({ toolCalls: repeated });
  assert.strictEqual(first.kind, 'nudge');
  const second = guard.observe({ toolCalls: repeated });
  assert.strictEqual(second.kind, 'abort');
});

test('LoopGuard：参数易变字段（timestamp/uuid）规范化后算重复', () => {
  const guard = new LoopGuard({ maxExactRepeats: 2, nudgeLimit: 2 });
  guard.observe({
    toolCalls: [
      call('api', { url: '/x', timestamp: '2026-01-01T00:00:00Z', request_id: 'aaa-bbb' }),
    ],
  });
  const decision = guard.observe({
    toolCalls: [
      call('api', { url: '/x', timestamp: '2027-06-06T00:00:00Z', request_id: 'ccc-ddd' }),
    ],
  });
  assert.strictEqual(decision.kind, 'nudge');
});

test('LoopGuard：长随机串参数掩码归一（opaque token）', () => {
  assert.strictEqual(
    canonicalArgs({ key: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' }),
    canonicalArgs({ key: 'ffffffffffffffffffffffffffffffff' }),
  );
  // 短普通字符串不掩码
  assert.notStrictEqual(canonicalArgs({ key: 'hello' }), canonicalArgs({ key: 'world' }));
});

test('LoopGuard：A→B→A→B 循环模式被识别（周期 2）', () => {
  const guard = new LoopGuard({ cycleWindow: 8, nudgeLimit: 2 });
  guard.observe({ toolCalls: [call('search')] });
  guard.observe({ toolCalls: [call('read_file')] });
  guard.observe({ toolCalls: [call('search')] });
  const decision = guard.observe({ toolCalls: [call('read_file')] });
  assert.strictEqual(decision.kind, 'nudge');
});

test('LoopGuard：非循环序列不误报', () => {
  const guard = new LoopGuard({ cycleWindow: 8 });
  const seq = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (const name of seq) {
    assert.deepStrictEqual(guard.observe({ toolCalls: [call(name)] }), { kind: 'allow' });
  }
});

test('LoopGuard：wall-clock 超时熔断（注入 ts 驱动时钟）', () => {
  const guard = new LoopGuard({ maxDurationMs: 1000 });
  const start = 1_000_000;
  assert.deepStrictEqual(guard.observe({ toolCalls: [call('x')], ts: start }), { kind: 'allow' });
  const decision = guard.observe({ toolCalls: [call('x')], ts: start + 1001 });
  assert.strictEqual(decision.kind, 'abort');
});

test('LoopGuard：nudge 文案要求换方法而非重复尝试', () => {
  const guard = new LoopGuard({ maxExactRepeats: 1, nudgeLimit: 2 });
  const decision = guard.observe({ toolCalls: [call('grep', { pattern: 'x' })] });
  assert.strictEqual(decision.kind, 'nudge');
  assert.ok(decision.kind === 'nudge' && decision.message.includes('换一种方法'));
});
