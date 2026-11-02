// `serve` 工作区信任选项工厂的判据（此前 serveTrust 覆盖率 26.66%，只有 create 分支被间接执行）。
//
// 关注三件事：① `--trust-workspace` 正确映射到 grant；② onDecision 把 decision.mode 写回 state；
// ③ 发现式清单走 stderr（不得污染 stdout / 不得静默吞掉）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ServeTrust } from '../../src/apps/cli/serveTrust.ts';
import type { WorkspaceTrustDecision } from '../../src/contracts/ports/config/workspaceTrust.ts';

/** 构造一条最小信任决策。 */
function decisionOf(mode: 'trusted' | 'restricted'): WorkspaceTrustDecision {
  return {
    mode,
    workspace: 'D:\\proj',
    configHash: 'hash',
    requested: [],
    ignored: [],
    granted: mode === 'trusted',
    warnings: [],
  };
}

test('create：--trust-workspace 映射为 grant，缺省不授权', () => {
  assert.strictEqual(ServeTrust.create([]).options.grant, false);
  assert.strictEqual(ServeTrust.create(['serve', '--port', '9000']).options.grant, false);
  assert.strictEqual(
    ServeTrust.create(['serve', '--trust-workspace']).options.grant,
    true,
    '显式旗标必须映射到 grant',
  );
});

test('onDecision：mode 写回 state，并把发现式清单写到 stderr', () => {
  const written: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const binding = ServeTrust.create([]);
    assert.strictEqual(binding.state.trusted, false);
    binding.options.onDecision?.(decisionOf('trusted'));
    assert.strictEqual(binding.state.trusted, true, 'trusted 必须写回 state');
    assert.match(written.join(''), /已信任工作区：D:\\proj/u, '清单必须走 stderr');
    written.length = 0;
    binding.options.onDecision?.(decisionOf('restricted'));
    assert.strictEqual(binding.state.trusted, false, 'restricted 必须写回 false');
    assert.strictEqual(written.length, 0, '无 ignored / 未 granted 时不刷屏');
  } finally {
    process.stderr.write = original;
  }
});
