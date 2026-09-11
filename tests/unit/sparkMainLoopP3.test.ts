// (P3) 高原创试点 接入主循环：刻蚀 / 元素组合 / 对称破缺 / 禁闭色荷 经 SparkController autoRun 钩子真跑。
// 断言：
//   ① 同时启用四项 → spark 构造、cycle 报告 etching/elementComposer/symmetry/confinement 四维度，且确有产出；
//   ② 仅启用禁闭色荷也构造 spark（各算子独立触发接线），其余维度 undefined；
//   ③ 四项皆不启用 → spark 为 undefined（零破坏旁路）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SparkController } from '../../src/spark/sparkController.js';
import { InsightEtchingEngine } from '../../src/adapters/memory/insightEtchingEngine.js';
import { ElementComposer } from '../../src/adapters/skill/elementComposer.js';
import { SymmetryBreakingEngine } from '../../src/adapters/monitoring/symmetryBreakingEngine.js';
import { ConfinementEngine } from '../../src/adapters/monitoring/confinementEngine.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { ScriptedModel } from '../../src/eval/scriptedModel.js';

function tmpWs(): string {
  return mkdtempSync(join(tmpdir(), 'omni-p3-'));
}

test('① 四项同时启用 → spark 构造 + cycle 报告四维度，且确有产出', async () => {
  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], 'P3 完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    insightEtching: { enabled: true },
    elementComposer: { enabled: true },
    symmetryBreaking: { enabled: true, threshold: 0.6 },
    confinement: { enabled: true, groupOrder: 3 },
    sparkAutoRun: true,
  });
  assert.ok(config.spark instanceof SparkController, '四项启用时应构造 SparkController');
  assert.ok(config.etching instanceof InsightEtchingEngine);
  assert.ok(config.elementComposerEngine instanceof ElementComposer);
  assert.ok(config.symmetry instanceof SymmetryBreakingEngine);
  assert.ok(config.confinementEngine instanceof ConfinementEngine);

  const rep = await config.spark!.cycle();
  assert.strictEqual(rep.ran, true);
  // 刻蚀：尚未刻蚀 → traces=0，未提供匹配 query → 无导通。
  assert.ok(rep.etching !== undefined && rep.etching.traces === 0, '刻蚀维度应存在且 traces=0');
  // 元素组合：探针 Na+Cl → NaCl。
  assert.ok(
    rep.elementComposer !== undefined && rep.elementComposer.compound === 'NaCl',
    '组合探针应产出 NaCl',
  );
  // 对称破缺：探针观测单占优 → 破缺。
  assert.ok(rep.symmetry !== undefined && rep.symmetry.state === 'broken', '应观测到对称破缺');
  // 禁闭：探针为裸能力 → 拒配。
  assert.ok(
    rep.confinement !== undefined && rep.confinement.exposed === false,
    '裸能力应被禁闭拒配',
  );
});

test('② 仅启用禁闭色荷也构造 spark（各算子独立触发接线），其余维度 undefined', async () => {
  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], '禁闭完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    confinement: { enabled: true },
    sparkAutoRun: true,
  });
  assert.ok(config.spark instanceof SparkController, '仅禁闭也应构造 spark');
  assert.ok(config.confinementEngine instanceof ConfinementEngine);
  const rep = await config.spark!.cycle();
  assert.ok(rep.confinement !== undefined && rep.confinement.exposed === false);
  assert.strictEqual(rep.etching, undefined, '未启用刻蚀则无该维度');
  assert.strictEqual(rep.elementComposer, undefined);
  assert.strictEqual(rep.symmetry, undefined);
});

test('③ 四项皆不启用 → spark 为 undefined（零破坏旁路）', () => {
  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], '旁路'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    resonantField: { enabled: false },
    sparkAutoRun: true,
  });
  assert.strictEqual(config.spark, undefined, '四项皆关则 spark 不应构造');
  assert.strictEqual(config.etching, undefined);
  assert.strictEqual(config.elementComposerEngine, undefined);
  assert.strictEqual(config.symmetry, undefined);
  assert.strictEqual(config.confinementEngine, undefined);
});
