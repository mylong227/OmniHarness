/**
 * Wave B4（ADR-0009 · EVOLVIX_SPEC §7 Wave B 验收）：**注册 → 评估 → 晋升 → 回滚端到端**。
 *
 * 串起来的是四件**已落地**的东西，而不是测试专用桩：
 * `OperatorPort.propose`（既有燧-1 有界发现引擎，零休眠代码）→ `CapabilityRegistry.put`
 * （第二个资产类型的校验把关）→ `CapabilityEvaluator`（按类型声明的度量）→ 台账
 * `snapshotBefore`/`append` 晋升 → `rollback` 还原**逐条深相等**。
 *
 * 另判 J7 的第二类型面：**第三种未注册类型**在同一入口被拒——新协议不是只为 skill 开的后门。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityEvaluator } from '../../src/capability/capabilityEvaluator.js';
import { CapabilityRegistry } from '../../src/capability/capabilityRegistry.js';
import { CapabilitySchemaRegistry } from '../../src/capability/capabilitySchemaRegistry.js';
import { SkillSchema } from '../../src/capability/schemas/skillSchema.js';
import {
  WorkflowTemplateSchema,
  type WorkflowTemplate,
} from '../../src/capability/schemas/workflowTemplateSchema.js';
import { HashChainPromotionLedger } from '../../src/evolution/hashChainPromotionLedger.js';
import { TwistDiscoveryEngine } from '../../src/evolution/twistDiscoveryEngine.js';
import { MoireComposer } from '../../src/skill/moireComposer.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import type { CapabilityRecord } from '../../src/ports/capability.js';
import type { Skill } from '../../src/skill/skill.js';

/**
 * 造一个合法工作流模板。
 * @param name 模板名
 * @returns WorkflowTemplate
 */
function templateOf(name: string): WorkflowTemplate {
  return {
    name,
    description: `${name} 模板`,
    inputs: ['repo'],
    steps: [
      { name: 'scan', action: '扫描仓库', requires: ['repo'], produces: ['findings'] },
      { name: 'fix', action: '按清单修复', requires: ['findings'], produces: ['patch'] },
    ],
  };
}

/**
 * 把模板包成资产记录。
 * @param template 模板
 * @param operator 产生它的算子（lineage）
 * @returns CapabilityRecord
 */
function recordOf(template: WorkflowTemplate, operator: string): CapabilityRecord {
  return {
    asset: template,
    schemaKind: 'workflow-template',
    lineage: { parents: [], operator, bornAt: '2026-10-04T00:00:00.000Z' },
    fitness: undefined,
    governance: {
      trustTier: 'core',
      isolation: 'in-process',
      state: 'active',
      ledgerSeq: undefined,
    },
  };
}

test('B4 端到端：算子产出 → 新类型入册 → 评估 → 台账晋升 → 回滚逐条深相等', async () => {
  const ledger = new HashChainPromotionLedger({ now: () => '2026-10-04T00:00:00.000Z' });
  const registry = new SkillRegistry();
  const seed: readonly Skill[] = [
    { name: 'scan-repo', description: '扫描', instructions: '扫描仓库结构。', tags: ['扫描'] },
    { name: 'fix-list', description: '修复', instructions: '按清单修复。', tags: ['修复'] },
  ];
  for (const skill of seed) registry.register(skill);
  const schemas = new CapabilitySchemaRegistry();
  schemas.register(new SkillSchema());
  schemas.register(new WorkflowTemplateSchema());
  const governed = new CapabilityRegistry({ schemas, skills: registry, ledger });

  // ① 算子（既有有界发现引擎实现 OperatorPort）产出候选 —— 工况桶键进入来源。
  const operator = new TwistDiscoveryEngine({
    skills: () => registry.list(),
    compose: (a, b, o) => MoireComposer.composeByTwist(a, b, o),
    maxCandidates: 4,
  });
  const proposed = operator.propose({ bucketKey: 'wf', budget: operator.budgetUsed() });
  assert.strictEqual(proposed.length, 1, '两个种子技能 ⇒ 一对组合');
  assert.strictEqual(
    proposed[0]?.source,
    'twist:wf:scan-repo+fix-list',
    '工况桶键进入来源（下游分桶口径可见）',
  );
  assert.deepStrictEqual(
    operator.propose({ bucketKey: 'wf', budget: { generated: 4, maxCandidates: 4 } }),
    [],
    '预算耗尽即空批（算子绝不越预算）',
  );

  // ② 新类型入册（校验把关）。
  const record = recordOf(templateOf('ship-fix'), proposed[0]!.source);
  governed.put(record);
  assert.strictEqual(governed.recordOf('ship-fix')?.schemaKind, 'workflow-template');
  assert.strictEqual(governed.recordsOfKind('workflow-template').length, 1);

  // ③ 评估（度量由类型声明），产出 fitness（写与不写由调用方决定，评估器只出判据）。
  const evaluator = new CapabilityEvaluator({ schemas, evaluator: 'b4' });
  const fitness = await evaluator.fitnessOf(record, '2026-10-04T00:00:02.000Z');
  assert.deepStrictEqual(fitness, {
    benchmark: 1,
    evaluatedAt: '2026-10-04T00:00:02.000Z',
    evaluator: 'b4',
  });

  // ④ 晋升：先快照后 append（无快照不晋升的调用方纪律），链验签绿。
  const before = registry.list().map((s) => ({ ...s }));
  const snapshotSeq = ledger.snapshotBefore(before);
  const seq = ledger.append({ name: 'ship-fix', source: record.lineage.operator });
  assert.strictEqual(seq, snapshotSeq + 1);
  assert.strictEqual(ledger.verify().ok, true);

  // ⑤ 回滚：还原计划与快照逐条深相等（不得静默残留新增资产）。
  const plan = ledger.rollback(snapshotSeq);
  assert.strictEqual(plan.seq, snapshotSeq);
  assert.deepStrictEqual(plan.skills, before, '回滚产物必须与快照逐条深相等');
  assert.strictEqual(ledger.verify().ok, true, '回滚事件入链后链仍完整');
});

test('B4 J7 第二类型面：第三种未注册类型在同一入口被拒（不是只为 skill 开的后门）', () => {
  const schemas = new CapabilitySchemaRegistry();
  schemas.register(new WorkflowTemplateSchema());
  const governed = new CapabilityRegistry({ schemas });
  const asOperatorAsset: CapabilityRecord = {
    ...recordOf(templateOf('meta'), 'hand'),
    schemaKind: 'operator',
  };
  assert.throws(
    () => governed.put(asOperatorAsset),
    /资产类型未注册: operator/,
    '未注册类型（即便结构合法）也必须被拒',
  );
  assert.deepStrictEqual(governed.recordsOfKind('operator'), []);
});
