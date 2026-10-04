/**
 * Wave B2（ADR-0009 · EVOLVIX_SPEC §8 J6）：**绞杀者等价**判据。
 *
 * 判据：`CapabilityRegistry` 上的「选择 → 稀疏化 → 渲染」与 `SkillRegistry` 上同一条链
 * **逐位一致**（不只是"差不多"）：同一个技能池、同一批提示，断言
 * ① `rankForPrompt` 的命中序列（名字 **与分数**）、② `selectForPrompt` 的截断序列、
 * ③ `SkillSparsifier` 的 kept/dropped/scores、④ 渲染文本序列——**全部 `deepStrictEqual`**。
 *
 * ## 为什么这条判据必须有牙齿（变异自证）
 *
 * 「两边都委托同一份实现」时，判据很容易退化成恒真。故本文件把对照写成**可注入的实现对**，
 * 并用一个**故意不等价**的对照实现跑同一套比较：它必须**红**。仪器自证通过后，
 * 同一把尺子用在真实实现上，绿灯才有意义（沿本仓「正对照/仪器自证」纪律）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/capability/capabilityRegistry.js';
import { CapabilitySchemaRegistry } from '../../src/capability/capabilitySchemaRegistry.js';
import { SkillSchema } from '../../src/capability/schemas/skillSchema.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import { SkillSparsifier } from '../../src/skill/skillSparsifier.js';
import type { Skill } from '../../src/skill/skill.js';

/** 生产注入路径用的预算/豁免口径（与 `SessionInjector` 同值）。 */
const SPARSE = { maxSkills: 5, minKeepScore: 3 };

/** 注入路径的最小依赖面（`SkillRegistry` 与 `CapabilityRegistry` 都满足）。 */
interface SelectionSurface {
  rankForPrompt(text: string): readonly { readonly skill: Skill; readonly score: number }[];
  selectForPrompt(text: string): readonly Skill[];
  render(skill: Skill): string;
}

/**
 * 造测试技能池（覆盖 BM25 命中强度差异：名字命中 / 标签命中 / 无关）。
 * @returns 技能列表
 */
function pool(): readonly Skill[] {
  return [
    {
      name: 'sql-review',
      description: 'SQL 审查',
      instructions: '审查 SQL 注入与索引。',
      tags: ['数据库'],
    },
    {
      name: 'refactor-extract',
      description: '提取函数',
      instructions: '把重复代码提取为函数。',
      tags: ['重构'],
    },
    {
      name: 'gate-checklist',
      description: '门禁清单',
      instructions: '按门禁清单逐条核对。',
      tags: ['门禁'],
    },
    {
      name: 'memory-primer',
      description: '记忆对齐',
      instructions: '开工前对齐长期记忆。',
      tags: ['记忆'],
    },
    {
      name: 'unrelated-topic',
      description: '无关项',
      instructions: '与查询无关的能力。',
      tags: ['其他'],
    },
  ];
}

/** 提示语料（含中英混合、同义改写与陷阱查询）。 */
const PROMPTS: readonly string[] = [
  '请帮我 sql-review 一下这个查询',
  '把重复代码提取为函数',
  '门禁清单怎么用',
  '帮我做长期记忆对齐',
  '今天天气怎么样',
  'sql',
  '   ',
];

/**
 * 跑一遍生产注入链，产出可逐位对照的完整轨迹。
 * @param surface 选择面实现
 * @returns 轨迹（每条提示的四个观察面）
 */
function trace(surface: SelectionSurface): unknown {
  const sparsifier = new SkillSparsifier(SPARSE);
  return PROMPTS.map((prompt) => {
    const ranked = surface.rankForPrompt(prompt);
    const matched = ranked.map((hit) => hit.skill);
    const sparse = sparsifier.sparsify(
      matched,
      prompt.toLowerCase(),
      new Map(ranked.map((hit) => [hit.skill.name, hit.score])),
    );
    return {
      ranked: ranked.map((hit) => [hit.skill.name, hit.score]),
      selected: surface.selectForPrompt(prompt).map((s) => s.name),
      kept: sparse.kept.map((s) => s.name),
      dropped: sparse.dropped.map((s) => s.name),
      scores: [...sparse.scores.entries()].sort(),
      rendered: sparse.kept.map((s) => surface.render(s)),
    };
  });
}

/**
 * 建一对「同一个技能池」的注册表：既有实现 vs 新协议注册表。
 * @returns 两个选择面
 */
function pair(): { readonly legacy: SkillRegistry; readonly capability: CapabilityRegistry } {
  const legacy = new SkillRegistry();
  for (const skill of pool()) legacy.register(skill);
  const schemas = new CapabilitySchemaRegistry();
  schemas.register(new SkillSchema());
  const capability = new CapabilityRegistry({ schemas, skills: legacy });
  return { legacy, capability };
}

test('B2 J6 绞杀者等价：选择→稀疏化→渲染的完整轨迹逐位一致（名字 + 分数 + 顺序 + 渲染文本）', () => {
  const { legacy, capability } = pair();
  const legacyTrace = trace(legacy);
  // 前提：轨迹本身非空（否则「相等」无意义——正对照纪律）。
  const nonEmpty = JSON.stringify(legacyTrace).length;
  assert.ok(nonEmpty > 200, `参照轨迹必须非平凡（实际 ${nonEmpty} 字节）`);
  assert.deepStrictEqual(trace(capability), legacyTrace, '新协议注册表必须与既有实现逐位一致');
});

test('B2 J6 仪器自证：故意不等价的对照实现必须被判红（否则这条判据恒真、没有牙齿）', () => {
  const { legacy } = pair();
  const reference = trace(legacy);
  const sabotaged: SelectionSurface = {
    // 变异：把排名结果反转（模拟「注册表换了选择实现」这类真实漂移）。
    rankForPrompt: (text) => [...legacy.rankForPrompt(text)].reverse(),
    selectForPrompt: (text) => legacy.selectForPrompt(text),
    render: (skill) => legacy.render(skill),
  };
  assert.notDeepStrictEqual(trace(sabotaged), reference, '反转排名必须被这套对照抓住');
});

test('B2 委托面：SkillPort 全量成员逐项透传（同一份技能表，不是各存一份）', () => {
  const { legacy, capability } = pair();
  assert.deepStrictEqual(
    capability.list().map((s) => s.name),
    legacy.list().map((s) => s.name),
    'list 顺序即内部注册表插入序',
  );
  assert.strictEqual(capability.get('sql-review'), legacy.get('sql-review'), 'get 返回同引用');
  assert.deepStrictEqual(
    capability.match('sql-review').map((s) => s.name),
    legacy.match('sql-review').map((s) => s.name),
  );

  // 通过新注册表写入 → 既有注册表立刻可见（同一状态源，无影子副本）。
  capability.register({ name: 'extra', description: 'x', instructions: 'y' });
  assert.ok(legacy.get('extra') !== undefined, '写入必须落到同一张表上');
  capability.replace({ name: 'extra', description: 'x2', instructions: 'y2' });
  assert.strictEqual(legacy.get('extra')?.description, 'x2');
  assert.strictEqual(capability.remove('extra'), true);
  assert.strictEqual(legacy.get('extra'), undefined, '移除同样作用于同一张表');

  // 重名注册的失败语义与既有实现一致（抛）。
  assert.throws(
    () => capability.register(pool()[0]!),
    /技能重复注册: sql-review/,
    '失败语义也必须逐字一致',
  );
});

test('B2 组合算子透传：composeByTwist 仍写入内部技能表并返回同一产物', () => {
  const { legacy, capability } = pair();
  const composed = capability.composeByTwist(pool()[0]!, pool()[1]!);
  assert.ok(composed.name.length > 0);
  assert.ok(
    legacy.get(composed.name) !== undefined,
    '组合产物必须落进同一张表（既有自动注册语义）',
  );
  assert.strictEqual(capability.render(composed), legacy.render(composed), '渲染逐字一致');
});

test('B2 资产面（基础）：put 入册并把本体落进技能表、recordOf 取回、recordsOfKind 按类型列举', () => {
  const { legacy, capability } = pair();
  const asset: Skill = { name: 'workflow-seed', description: '新资产', instructions: '步骤。' };
  capability.put({
    asset,
    schemaKind: 'skill',
    lineage: { parents: ['a', 'b'], operator: 'twist:a+b', bornAt: '2026-10-04T00:00:00.000Z' },
    fitness: { benchmark: 0.42, evaluatedAt: '2026-10-04T00:00:01.000Z', evaluator: 'test' },
    governance: {
      trustTier: 'core',
      isolation: 'os-sandbox',
      state: 'active',
      ledgerSeq: undefined,
    },
  });
  assert.strictEqual(legacy.get('workflow-seed'), asset, 'put 必须把本体落进同一张技能表');
  const record = capability.recordOf('workflow-seed');
  assert.strictEqual(record?.schemaKind, 'skill');
  assert.strictEqual(record?.fitness?.benchmark, 0.42);
  assert.deepStrictEqual(record?.lineage.parents, ['a', 'b']);
  assert.strictEqual(capability.recordsOfKind('skill').length, 1, '只统计显式入册的记录');
  assert.deepStrictEqual(capability.recordsOfKind('operator'), []);
  assert.throws(
    () => capability.put({ ...record!, asset }),
    /资产重复入册: workflow-seed/,
    '重复入册即拒（不静默覆盖治理与溯源）',
  );
});

test('B2 资产面（回落）：既有技能无记录时按类型默认档惰性合成；类型未注册则不冒充协议内资产', () => {
  const { capability } = pair();
  const synthesized = capability.recordOf('sql-review');
  assert.strictEqual(synthesized?.schemaKind, 'skill');
  assert.strictEqual(synthesized?.governance.trustTier, 'core', '默认档来自 SkillSchema');
  assert.strictEqual(synthesized?.governance.isolation, 'os-sandbox');
  assert.strictEqual(synthesized?.governance.ledgerSeq, undefined);
  assert.strictEqual(synthesized?.lineage.operator, 'registry:legacy');
  assert.strictEqual(capability.recordOf('no-such-asset'), undefined);

  const bare = new CapabilityRegistry({ schemas: new CapabilitySchemaRegistry() });
  bare.register(pool()[0]!);
  assert.strictEqual(
    bare.recordOf('sql-review'),
    undefined,
    'skill 类型未注册时不得冒充协议内资产（「未注册即拒」的另一面）',
  );
});
