// (P2) 组合·拓扑 接入主循环：CRISPR 精确编辑 + 相变固化 经 SparkController autoRun 钩子真跑。
// 断言：
//   ① 同时启用 skillEditing + capabilityCrystallization → spark 构造、cycle 报告 crispr + crystallizer，且确有产出；
//   ② 仅启用相变固化也构造 spark（两算子各自独立触发接线），cycle 报告 crystallizer 维度；
//   ③ 两者皆不启用 → spark 为 undefined（零破坏旁路）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill } from '../../src/skill/skill.js';
import { SparkController } from '../../src/spark/sparkController.js';
import { CRISPRSkillEditor } from '../../src/adapters/skill/crisprSkillEditor.js';
import { CapabilityCrystallizer } from '../../src/adapters/skill/capabilityCrystallizer.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { ScriptedModel } from '../../src/eval/scriptedModel.js';

const skillA: Skill = { name: 'skillA', description: 'A', instructions: '执行 A 流程。' };
const skillB: Skill = { name: 'skillB', description: 'B', instructions: '执行 B 流程。' };
const skillC: Skill = { name: 'skillC', description: 'C', instructions: '执行 C 流程。' };

function tmpWs(): string {
  return mkdtempSync(join(tmpdir(), 'omni-p2b-'));
}

test('① 两算子同时启用 → spark 构造 + cycle 报告 crispr/crystallizer，且确有编辑与冻结产出', async () => {
  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], '组合·拓扑完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    skills: [skillA, skillB, skillC],
    skillEditing: { enabled: true },
    capabilityCrystallization: { enabled: true, densityThreshold: 3 },
    sparkAutoRun: true,
  });
  assert.ok(config.spark instanceof SparkController, '两算子启用时应构造 SparkController');
  assert.ok(config.crispr instanceof CRISPRSkillEditor, '应注入 CRISPR 编辑器');
  assert.ok(config.crystallizer instanceof CapabilityCrystallizer, '应注入相变固化器');

  // 排入一次 CRISPR 定点编辑（队列，待主循环 flush）。
  config.crispr!.queue({
    target: 'skillA',
    patch: (s) => s + '\n新增：A 的强化步骤。',
    differentialTest: () => true,
  });
  // 累积常用组合经验密度（序参量抬升越阈）。
  config.crystallizer!.observe(['skillA', 'skillB']);
  config.crystallizer!.observe(['skillA', 'skillB']);
  config.crystallizer!.observe(['skillA', 'skillB']);

  const rep = await config.spark!.cycle();
  assert.strictEqual(rep.ran, true);
  // CRISPR 阶段确有提交。
  assert.ok(rep.crispr !== undefined && rep.crispr.length === 1, '应含 CRISPR 阶段产出');
  assert.strictEqual(rep.crispr![0]!.applied, true, '定点编辑应被应用');
  assert.ok(
    config.skillRegistry.get('skillA')!.instructions.includes('强化步骤'),
    '编辑应写回技能端口',
  );
  // 相变固化阶段确有冻结。
  assert.ok(rep.crystallizer !== undefined, '应含相变固化维度');
  assert.ok(rep.crystallizer!.frozen.length >= 1, '常用组合应被冻结为原生能力');
  const frozenName = rep.crystallizer!.frozen[0]!;
  assert.strictEqual(
    config.skillRegistry.get(frozenName)?.frozen,
    true,
    '冻结能力应注册且标记 frozen',
  );
});

test('② 仅启用相变固化也构造 spark（两算子各自独立触发接线），cycle 报告 crystallizer', async () => {
  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], '相变固化完成'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    skills: [skillA, skillB, skillC],
    capabilityCrystallization: { enabled: true, densityThreshold: 2 },
    sparkAutoRun: true,
  });
  assert.ok(config.spark instanceof SparkController, '仅相变固化也应构造 spark');
  assert.ok(config.crystallizer instanceof CapabilityCrystallizer);
  assert.ok(config.crispr === undefined, 'CRISPR 未启用则不应构造');

  config.crystallizer!.observe(['skillA', 'skillB']);
  config.crystallizer!.observe(['skillA', 'skillB']);
  const rep = await config.spark!.cycle();
  assert.ok(rep.crystallizer !== undefined);
  assert.ok(rep.crystallizer!.frozen.length >= 1, '应冻结一条常用组合');
  assert.ok(rep.crispr === undefined, '未启用 CRISPR 则不应有该维度');
});

test('③ 两者皆不启用 → spark 为 undefined（零破坏旁路）', () => {
  const config = ConfigFactory.build({
    workspaceRoot: tmpWs(),
    maxSteps: 8,
    model: new ScriptedModel([], '旁路'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    resonantField: { enabled: false },
    skills: [skillA, skillB, skillC],
    sparkAutoRun: true,
  });
  assert.strictEqual(config.spark, undefined, '两算子皆关则 spark 不应构造');
  assert.strictEqual(config.crispr, undefined);
  assert.strictEqual(config.crystallizer, undefined);
});
