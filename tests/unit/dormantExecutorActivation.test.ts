/**
 * S6（GEE Kernel v1 · ADR-0008 决策 6）：休眠执行体转正判据。
 *
 * 蓝图判据（EVOLUTION_ARCH_UPGRADE_2026-10 §4 S6）：
 * - 端到端：真实形态提案 → `CrisprEditSpec` → **差异测试通过才应用、失败即回滚**（复用编辑器既有判据）；
 * - **变异**：绕过差异测试 ⇒ 红（编辑器「不传即接受」的缺省在生产不可接受）；
 * - 固化**只新增不删改**（沿固化器铁律），越阈后密度归零、重复越阈只计已冻结；
 * - 附加：条款幂等（同一失败模式反复出现不撑爆 instructions）/ 单轮提案数有界 / 缺件如实申报。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DormantExecutorActivation } from '../../src/evolution/dormantExecutorActivation.js';
import { RlvrController } from '../../src/evolution/rlvrController.js';
import { CapabilityCrystallizer } from '../../src/adapters/skill/capabilityCrystallizer.js';
import { CRISPRSkillEditor } from '../../src/adapters/skill/crisprSkillEditor.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import type { Skill } from '../../src/skill/skill.js';
import type { CrisprEditReport, CrisprEditSpec } from '../../src/ports/runtime/skillEdit.js';
import type { ImprovementProposal } from '../../src/evolution/failurePatternMiner.js';

/** 莫尔基准场边长（与门禁默认同口径）。 */
const FIELD = 64;

/**
 * 造技能（可带显式能力场：显式场与 instructions 无关，使门禁基准对文本改写**不敏感**——
 * 这正是「差异测试 = 基准非回退」在文本改写场景下的可控实验条件）。
 * @param name 技能名
 * @param withField 是否附显式能力场
 * @returns Skill
 */
function skillOf(name: string, withField = false): Skill {
  return {
    name,
    description: `${name} 描述`,
    instructions: `${name} 步骤：先核对输入，再产出结果。`,
    tags: [name],
    ...(withField
      ? { capabilityField: Array.from({ length: FIELD * FIELD }, (_, i) => Math.sin(i / 7)) }
      : {}),
  };
}

/**
 * 造改进提案。
 * @param signatureKey 失败签名键
 * @param occurrences 出现次数
 * @returns 改进提案
 */
function proposalOf(signatureKey: string, occurrences = 3): ImprovementProposal {
  return {
    signatureKey,
    occurrences,
    summary: `「${signatureKey}」失败 ${occurrences} 次：建议以机械门禁/检测器/清单判据防再犯（样本：gate/a、gate/b）`,
  };
}

/**
 * 记录型 CRISPR 桩：只记录入队规格，不对技能做任何改动（用于断言规格形状）。
 */
class RecordingCrispr {
  /** 入队规格（按入队顺序）。 */
  public readonly queued: CrisprEditSpec[] = [];
  /** flush 返回的固定报告。 */
  public readonly reports: CrisprEditReport[] = [];

  /**
   * 入队。
   * @param spec 编辑规格
   * @returns 无返回值（void）
   */
  public queue(spec: CrisprEditSpec): void {
    this.queued.push(spec);
  }

  /**
   * 批量执行（桩：只回放预设报告）。
   * @returns 报告列表
   */
  public flush(): readonly CrisprEditReport[] {
    return this.reports;
  }

  /**
   * 单次编辑（桩不实现）。
   * @returns 未应用报告
   */
  public edit(): CrisprEditReport {
    return { applied: false, semanticAddress: false, rolledBack: false, reason: 'stub' };
  }

  /**
   * 已应用计数（桩恒 0）。
   * @returns 0
   */
  public appliedCount(): number {
    return 0;
  }
}

test('S6 差异测试拦截：基准回退的修订被回滚，原技能一字不动（脱靶防住）', () => {
  const registry = new SkillRegistry();
  const original = skillOf('immune-check');
  registry.register(original);
  // 注入「改了就掉分」的尺子：修订后得分 < 修订前 ⇒ 差异测试必须拦下。
  const regressing = (skill: Skill): number => (skill.instructions.includes('【防再犯】') ? 0 : 1);
  const activation = new DormantExecutorActivation({
    score: regressing,
    crispr: new CRISPRSkillEditor({ skillPort: registry, addressThreshold: 0 }),
    addressThreshold: 0,
  });

  const report = activation.activate([proposalOf('gate:delta × immuneMonitoring')]);
  assert.strictEqual(report.crisprQueued, 1);
  assert.strictEqual(report.crisprApplied, 0, '基准回退 ⇒ 不得应用');
  assert.strictEqual(report.crisprRolledBack, 1, '差异测试不通过 ⇒ 回滚');
  assert.deepStrictEqual(registry.get('immune-check'), original, '回滚后原技能必须逐字不变');
});

test('S6 变异判据：规格必须自带差异测试（编辑器「不传即接受」的缺省不可用于生产）', () => {
  /**
   * 用给定尺子跑一轮，取回入队规格。
   * @param score 门禁基准打分
   * @returns 入队规格
   */
  function capture(score: (skill: Skill) => number): CrisprEditSpec {
    const stub = new RecordingCrispr();
    new DormantExecutorActivation({ score, crispr: stub, addressThreshold: 0 }).activate([
      proposalOf('test:assert × core'),
    ]);
    assert.strictEqual(stub.queued.length, 1);
    return stub.queued[0]!;
  }

  const original = skillOf('a');
  const patched: Skill = { ...original, instructions: `${original.instructions}\n【防再犯】x` };

  const flat = capture(() => 0.5);
  assert.strictEqual(
    typeof flat.differentialTest,
    'function',
    '必须挂差异测试（否则编辑器默认接受 ⇒ 变异即红）',
  );
  assert.strictEqual(flat.differentialTest!(original, patched), true, '同分 ⇒ 非回退，放行');

  const regressing = capture((skill) => (skill.instructions.includes('【防再犯】') ? 0.4 : 0.5));
  assert.strictEqual(regressing.differentialTest!(original, patched), false, '掉分 ⇒ 拦下');
});

test('S6 应用路径：显式能力场下文本改写不改变门禁基准 ⇒ 非回退，差异测试放行并按条款落地', () => {
  const registry = new SkillRegistry();
  registry.register(skillOf('immune-check', true));
  const activation = new DormantExecutorActivation({
    score: RlvrController.defaultGateScore(),
    crispr: new CRISPRSkillEditor({ skillPort: registry, addressThreshold: 0 }),
    addressThreshold: 0,
  });
  const proposal = proposalOf('gate:delta × immuneMonitoring');
  const report = activation.activate([proposal]);
  assert.deepStrictEqual(
    {
      queued: report.crisprQueued,
      applied: report.crisprApplied,
      rolledBack: report.crisprRolledBack,
    },
    { queued: 1, applied: 1, rolledBack: 0 },
    '基准非回退 ⇒ 差异测试放行、编辑提交',
  );
  const patched = registry.get('immune-check');
  assert.ok(patched !== undefined);
  assert.match(patched.instructions, /【防再犯】/, '条款已追加');
  assert.match(patched.instructions, /gate:delta × immuneMonitoring/);
  assert.match(patched.description, /已 CRISPR 定点修订/, '描述同步派生（契约不漂移）');

  // 幂等：同一失败模式再来一轮 ⇒ 条款已在，patch 原样返回 → 编辑器报 no-op，instructions 不增长。
  const before = patched.instructions;
  const again = activation.activate([proposal]);
  assert.strictEqual(again.crisprApplied, 0);
  assert.strictEqual(again.crisprSkipped, 1, '幂等跳过（no-op）而非重复追加');
  assert.strictEqual(registry.get('immune-check')?.instructions, before, 'instructions 不得被撑爆');
});

test('S6 条款幂等 + 目标语义 + 寻址阈值：规格形状可断言（纯函数口径）', () => {
  const stub = new RecordingCrispr();
  const activation = new DormantExecutorActivation({
    score: () => 1,
    crispr: stub,
    addressThreshold: 0.9,
  });
  const proposal = proposalOf('eval:passk × context', 5);
  activation.activate([proposal]);
  const spec = stub.queued[0]!;
  assert.strictEqual(spec.target, proposal.summary, '目标 = 提案摘要（非精确名 ⇒ 走语义寻址）');
  assert.strictEqual(spec.addressThreshold, 0.9, '寻址阈值透传进规格（端口契约字段）');
  const once = spec.patch('原有步骤。');
  assert.match(once, /【防再犯】/);
  assert.match(once, /已出现 5 次/, '条款携带频次证据');
  assert.strictEqual(spec.patch(once), once, '条款幂等：已带标记则原样返回');
});

test('S6 有界：单轮排队提案数受 maxProposals 约束（提案数无上限，编辑预算有上限）', () => {
  const stub = new RecordingCrispr();
  const activation = new DormantExecutorActivation({
    score: () => 1,
    crispr: stub,
    maxProposals: 2,
  });
  const report = activation.activate([
    proposalOf('sig-a'),
    proposalOf('sig-b'),
    proposalOf('sig-c'),
    proposalOf('sig-d'),
  ]);
  assert.strictEqual(report.crisprQueued, 2);
  assert.strictEqual(stub.queued.length, 2, '超出的提案留待下轮（不无界膨胀）');
});

test('S6 固化加法式：越阈只新增原生能力、源技能不动、密度归零、重复越阈只计已冻结', () => {
  const registry = new SkillRegistry();
  const a = skillOf('alpha');
  const b = skillOf('beta');
  registry.register(a);
  registry.register(b);
  const crystallizer = new CapabilityCrystallizer({ skillPort: registry, densityThreshold: 2 });
  const activation = new DormantExecutorActivation({
    score: RlvrController.defaultGateScore(),
    crystallizer,
  });

  // 未越阈：不冻结（密度 1 < 2）。
  crystallizer.observe(['alpha', 'beta']);
  const below = activation.activate([proposalOf('sig')]);
  assert.strictEqual(below.crystallized, 0, '未越阈不冻结');
  assert.strictEqual(crystallizer.density(['alpha', 'beta']), 1);

  // 越阈：冻结为原生能力（加法式）。
  crystallizer.observe(['alpha', 'beta']);
  const report = activation.activate([proposalOf('sig')]);
  assert.strictEqual(report.crystallized, 1, '越阈 ⇒ 冻结一条原生能力');
  assert.strictEqual(crystallizer.density(['alpha', 'beta']), 0, '越阈后密度归零（序参量回落）');
  assert.deepStrictEqual(registry.get('alpha'), a, '源技能绝不被删改（加法式铁律）');
  assert.deepStrictEqual(registry.get('beta'), b, '源技能绝不被删改（加法式铁律）');
  const frozenNames = crystallizer.frozen().map((f) => f.name);
  assert.strictEqual(frozenNames.length, 1);
  assert.ok(registry.get(frozenNames[0]!) !== undefined, '冻结产物真实落进注册表');

  // 重复：再越阈只计 alreadyFrozen，不重复注册。
  crystallizer.observe(['alpha', 'beta']);
  crystallizer.observe(['alpha', 'beta']);
  const repeat = activation.activate([proposalOf('sig')]);
  assert.strictEqual(repeat.crystallized, 0, '已冻结组合不重复注册');
  assert.strictEqual(repeat.alreadyFrozen, 1);
  assert.strictEqual(crystallizer.frozen().length, 1);
});

test('S6 缺件如实申报：CRISPR / 固化器缺一则 degraded 点名，满配为空', () => {
  const none = new DormantExecutorActivation({ score: () => 0 });
  assert.deepStrictEqual(none.degraded(), ['crispr:missing', 'crystallizer:missing']);
  assert.deepStrictEqual(none.activate([proposalOf('sig')]), {
    crisprQueued: 0,
    crisprApplied: 0,
    crisprRolledBack: 0,
    crisprSkipped: 0,
    crystallized: 0,
    alreadyFrozen: 0,
    crystallizationSkipped: 0,
  });

  const registry = new SkillRegistry();
  registry.register(skillOf('a'));
  const full = new DormantExecutorActivation({
    score: () => 0,
    crispr: new CRISPRSkillEditor({ skillPort: registry }),
    crystallizer: new CapabilityCrystallizer({ skillPort: registry }),
  });
  assert.deepStrictEqual(full.degraded(), [], '满配无降级申报');
});
