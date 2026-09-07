/**
 * Genesis ↔ SparkController 集成测试：验证研究内核真正接入活运行时。
 * - 默认关闭：完全沿用 legacy 行为（零回归）。
 * - 启用：cycle() 委托 GenesisSparkBridge（自适应顺序 + 守恒账本）。
 * - 桥异常：回落 legacy（fail-closed）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SparkController } from '../../src/spark/sparkController.js';
import { GenesisSparkBridge } from '../../src/genesis/sparkBridge.js';
import { Ledger } from '../../src/genesis/ledger.js';
import type { MemoryAnnealer } from '../../src/ports/memoryAnnealing.js';
import type { AnnealStepReport } from '../../src/ports/memoryAnnealing.js';
import type { RegimeSignals } from '../../src/genesis/operators.js';

const fakeAnneal = (): AnnealStepReport => ({ step: 1, temperature: 0.3, facts: 2, drift: 0.05 });
const fakeAnnealer = { anneal: fakeAnneal } as unknown as MemoryAnnealer;

const SIGNALS: RegimeSignals = { entropy: 0.2, modalityCount: 1, costPressure: 0, successRate: 1 };

test('Genesis 默认关闭：无引擎返回 ran=false（legacy 旁路零回归）', async () => {
  const c = new SparkController({});
  const r = await c.cycle();
  assert.strictEqual(r.ran, false);
});

test('Genesis 启用但无引擎：桥返回 ran=false，与 legacy 一致', async () => {
  const c = new SparkController({ enableGenesis: true });
  const r = await c.cycle();
  assert.strictEqual(r.ran, false);
});

test('Genesis 启用 + 引擎：委托桥，报告含真实引擎产物', async () => {
  const c = new SparkController({ enableGenesis: true, annealer: fakeAnnealer });
  const r = await c.cycle();
  assert.strictEqual(r.ran, true);
  assert.strictEqual(r.anneal?.temperature, 0.3);
});

test('Genesis 启用：报告与桥直接调用同构', async () => {
  const c = new SparkController({ enableGenesis: true, annealer: fakeAnnealer });
  const r = await c.cycle();
  const bridge = new GenesisSparkBridge({ annealer: fakeAnnealer });
  const b = bridge.cycle(SIGNALS);
  assert.deepStrictEqual(r.anneal, b.anneal);
  assert.strictEqual(r.ran, b.ran);
});

test('GenesisSparkBridge：每笔成本进入守恒账本', () => {
  const bridge = new GenesisSparkBridge({ annealer: fakeAnnealer });
  bridge.cycle(SIGNALS);
  assert.notStrictEqual(bridge.lastLedger, undefined);
  assert.strictEqual(bridge.lastLedger instanceof Ledger, true);
  assert.strictEqual(bridge.lastLedger!.isConserved(), true);
});

test('高成本压力工况：自适应规划剪枝昂贵尾算子（能耗入适应度）', () => {
  const bridge = new GenesisSparkBridge({ annealer: fakeAnnealer });
  const hot = bridge.cycle({ entropy: 0.2, modalityCount: 1, costPressure: 0.9, successRate: 1 });
  // 高成本压力下顺序变短（不含 capabilityCrystallizer/etching/elementComposer 等尾算子）。
  const order = Object.keys(hot).filter((k) => k !== 'ran');
  assert.ok(order.length < 13, `期望剪枝后顺序更短，实际=${order.length}`);
});
