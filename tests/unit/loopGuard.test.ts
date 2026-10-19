import { test } from 'vitest';
import assert from 'node:assert/strict';
import { LoopGuard } from '../../src/core/loop/loopGuard.ts';

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
    LoopGuard.canonicalArgs({ key: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' }), // omniharness:fake-secret（测试掩码归一夹具，非真实凭据）
    LoopGuard.canonicalArgs({ key: 'ffffffffffffffffffffffffffffffff' }),
  );
  // 短普通字符串不掩码
  assert.notStrictEqual(
    LoopGuard.canonicalArgs({ key: 'hello' }),
    LoopGuard.canonicalArgs({ key: 'world' }),
  );
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

test('LoopGuard：软时限只劝收尾（nudge），硬时限才熔断', () => {
  const guard = new LoopGuard({ softDeadlineMs: 1000, maxDurationMs: 2000 });
  const start = 1_000_000;
  assert.deepStrictEqual(guard.observe({ toolCalls: [call('x')], ts: start }), { kind: 'allow' });
  const soft = guard.observe({ toolCalls: [call('y')], ts: start + 1001 });
  assert.strictEqual(soft.kind, 'nudge');
  assert.ok(soft.kind === 'nudge' && soft.violation === 'soft-deadline');
  const hard = guard.observe({ toolCalls: [call('z')], ts: start + 2001 });
  assert.strictEqual(hard.kind, 'abort');
  assert.ok(hard.kind === 'abort' && hard.violation === 'wall-clock');
});

test('LoopGuard：nudge 文案要求换方法而非重复尝试', () => {
  const guard = new LoopGuard({ maxExactRepeats: 1, nudgeLimit: 2 });
  const decision = guard.observe({ toolCalls: [call('grep', { pattern: 'x' })] });
  assert.strictEqual(decision.kind, 'nudge');
  assert.ok(decision.kind === 'nudge' && decision.message.includes('换一种方法'));
});

test('LoopGuard：结果冗余——同一内容不连续地取回 4 次 → nudge（长会话主病）', () => {
  // 只测结果维度：关掉 exact-repeat / cycle，避免测试序列本身构成短周期。
  const guard = new LoopGuard({
    maxRedundantResults: 4,
    nudgeLimit: 2,
    cycleWindow: 0,
    maxExactRepeats: 0,
  });
  const body = 'x'.repeat(120);
  const unique = (name: string, ch: string) => ({
    toolCalls: [call(name, { path: ch })],
    results: [{ name, ok: true, output: ch.repeat(120) }],
  });
  assert.deepStrictEqual(
    guard.observe({
      toolCalls: [call('read_file')],
      results: [{ name: 'read_file', ok: true, output: body }],
    }),
    { kind: 'allow' },
  );
  assert.deepStrictEqual(guard.observe(unique('list_dir', 'y')), { kind: 'allow' });
  assert.deepStrictEqual(
    guard.observe({
      toolCalls: [call('read_file', { path: 'b' })],
      results: [{ name: 'read_file', ok: true, output: body }],
    }),
    { kind: 'allow' },
  );
  assert.deepStrictEqual(guard.observe(unique('grep', 'z')), { kind: 'allow' });
  assert.deepStrictEqual(
    guard.observe({
      toolCalls: [call('read_file', { path: 'c' })],
      results: [{ name: 'read_file', ok: true, output: body }],
    }),
    { kind: 'allow' },
  );
  assert.deepStrictEqual(guard.observe(unique('list_dir', 'w')), { kind: 'allow' });
  const decision = guard.observe({
    toolCalls: [call('read_file', { path: 'd' })],
    results: [{ name: 'read_file', ok: true, output: body }],
  });
  assert.strictEqual(decision.kind, 'nudge');
  assert.ok(decision.kind === 'nudge' && decision.message.includes('完全相同'));
});

test('LoopGuard：maxRedundantResults=0 关闭结果检测（全量关闭契约）', () => {
  const guard = new LoopGuard({ maxRedundantResults: 0, cycleWindow: 0, maxExactRepeats: 0 });
  const body = 'x'.repeat(200);
  for (let i = 0; i < 10; i += 1) {
    assert.deepStrictEqual(
      guard.observe({
        toolCalls: [call('read_file')],
        results: [{ name: 'read_file', ok: true, output: body }],
      }),
      { kind: 'allow' },
      'maxRedundantResults=0 必须真的关闭（不能只关一半）',
    );
  }
});

test('LoopGuard：结果冗余不误伤——短结果/失败结果/内容变化都不触发', () => {
  const guard = new LoopGuard({ maxRedundantResults: 4, cycleWindow: 0, maxExactRepeats: 0 });
  for (let i = 0; i < 8; i += 1) {
    assert.deepStrictEqual(
      guard.observe({
        toolCalls: [call('read_file')],
        results: [{ name: 'read_file', ok: true, output: 'ok' }],
      }),
      { kind: 'allow' },
      '过短结果重复是常态',
    );
    assert.deepStrictEqual(
      guard.observe({
        toolCalls: [call('shell')],
        results: [{ name: 'shell', ok: false, output: 'x'.repeat(200) }],
      }),
      { kind: 'allow' },
      '失败结果重试是合法行为',
    );
    assert.deepStrictEqual(
      guard.observe({
        toolCalls: [call('grep')],
        results: [{ name: 'grep', ok: true, output: `hit-${String(i)}-${'x'.repeat(100)}` }],
      }),
      { kind: 'allow' },
      '内容变化说明在推进',
    );
  }
});
