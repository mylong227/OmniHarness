/**
 * Laya 决策引擎配置解析单测（权威缝：配置 → 适配器构造）。
 *
 * 锁死：`DecisionEngineResolver` 是组合根里「配置 → 决策引擎适配器」的唯一构造点
 * （`ConfigFactory.resolveTools` 经 `new DecisionEngineResolver().resolve(partial)` 调用）。
 * `off` / 缺省必须返回 `undefined`（不装配、零行为，与 `selfVerify` 同模式）；
 * `shadow` / `enforce` 必须构造 `LayaDecisionEngine` 实例（行为差异在调用方，不在构造点）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LayaDecisionEngine } from '../../src/adapters/laya/layaDecisionEngine.js';
import { DecisionEngineResolver } from '../../src/config/decisionEngineResolver.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';

const resolver = new DecisionEngineResolver();

test('DecisionEngineResolver：off / 缺省不装配（undefined）', () => {
  const off = { decisionEngine: { mode: 'off' as const } } as unknown as OmniHarnessConfig;
  assert.strictEqual(resolver.resolve(off), undefined);
  const none = {} as unknown as OmniHarnessConfig;
  assert.strictEqual(resolver.resolve(none), undefined);
});

test('DecisionEngineResolver：shadow 构造 LayaDecisionEngine 实例', () => {
  const cfg = { decisionEngine: { mode: 'shadow' as const } } as unknown as OmniHarnessConfig;
  const engine = resolver.resolve(cfg);
  assert.ok(engine instanceof LayaDecisionEngine);
});
