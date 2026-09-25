import assert from 'node:assert/strict';
import test from 'node:test';
import { MoireComposer } from '../../src/skill/moireComposer.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import type { Skill } from '../../src/skill/skill.js';

const A: Skill = {
  name: 'dataExtract',
  description: '从网页抽取结构化表格',
  instructions: '定位 <table>，逐行解析单元格，输出 JSON。',
  tags: ['extract', 'web'],
};

const B: Skill = {
  name: 'summarize',
  description: '把长文本压缩为要点',
  instructions: '识别主题句，剔除冗余，输出 3 条要点。',
  tags: ['nlp'],
};

test('能力场派生确定可复现', () => {
  const f1 = MoireComposer.capabilityFieldOf(A, 64);
  const f2 = MoireComposer.capabilityFieldOf(A, 64);
  assert.strictEqual(f1.length, 64);
  assert.strictEqual(f1[5]![7]!, f2[5]![7]!);
  // 不同技能产生不同场（非角点单元，角点 (0,0) 恒为 0）
  const fB = MoireComposer.capabilityFieldOf(B, 64);
  assert.notStrictEqual(f1[5]![7]!, fB[5]![7]!);
});

test('莫尔组合产生涌现长波（扫描到最优扭转角）', () => {
  const c = MoireComposer.composeByTwist(A, B);
  assert.ok(c.moire, '复合技能应带 moire 元数据');
  const e = c.moire!.emergence;
  assert.ok(e > 0.3, `涌现强度应明显 > 0.3，实测=${e.toFixed(3)}`);
  // 已扫描到落在搜索区间内的相对扭转角（证明涌现来自扭转组合而非偶然）
  assert.ok(
    c.moire!.twistDeg >= 3 && c.moire!.twistDeg <= 87,
    `θ* 应落在扫描区间，实测=${c.moire!.twistDeg}`,
  );
});

test('单技能自身无此长波：涌现由组合而非任一技能单独产生', () => {
  const fa = MoireComposer.capabilityFieldOf(A, 64);
  const fb = MoireComposer.capabilityFieldOf(B, 64);
  // 任一技能与自身相乘（无相对扭转）→ 只是 f²，不产生莫尔长波
  const selfA = MoireComposer.emergenceAt(fa, fa, 64, 0, 2);
  const selfB = MoireComposer.emergenceAt(fb, fb, 64, 0, 2);
  const moire = MoireComposer.composeByTwist(A, B).moire!.emergence;
  assert.ok(
    selfA < 0.15 && selfB < 0.15,
    `单技能自身涌现应很低(selfA=${selfA.toFixed(3)}, selfB=${selfB.toFixed(3)})`,
  );
  assert.ok(
    moire > selfA + 0.2 && moire > selfB + 0.2,
    `组合涌现(${moire.toFixed(3)}) 应远高于单技能自身`,
  );
});

test('注册表集成：composeByTwist 生成并自注册可用复合技能', () => {
  const reg = new SkillRegistry();
  reg.register(A);
  reg.register(B);
  const c = reg.composeByTwist(A, B);
  assert.strictEqual(reg.get(c.name), c, '复合技能应已注册');
  assert.ok(reg.match('moire').includes(c), '复合技能应可被 moire tag 命中');
  assert.ok(c.instructions.includes(A.instructions) && c.instructions.includes(B.instructions));
});
