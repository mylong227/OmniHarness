// (P2, I-P2-4) CRISPRSkillEditor 单元测试：语义寻址定点 patch + 差异测试回滚（fail-closed）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Skill } from '../../src/skill/skill.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import { CRISPRSkillEditor } from '../../src/adapters/skill/crisprSkillEditor.js';

const skillA: Skill = {
  name: 'dataClean',
  description: '清洗数据',
  instructions: '读取原始数据并去除空值。',
};
const skillB: Skill = {
  name: 'chartDraw',
  description: '绘制图表',
  instructions: '根据数据列生成柱状图。',
};

function reg(): SkillRegistry {
  const r = new SkillRegistry();
  r.register(skillA);
  r.register(skillB);
  return r;
}

test('① 精确名 + 差异测试通过 → 定点 patch 提交，appliedCount=1，技能被原地改写', () => {
  const ed = new CRISPRSkillEditor({ skillPort: reg() });
  const rep = ed.edit({
    target: 'dataClean',
    patch: (s) => s + '\n新增：对异常值做 z 分数裁剪。',
    differentialTest: () => true,
  });
  assert.strictEqual(rep.applied, true);
  assert.strictEqual(rep.semanticAddress, false);
  assert.strictEqual(rep.rolledBack, false);
  assert.strictEqual(rep.skillName, 'dataClean');
  assert.strictEqual(ed.appliedCount(), 1);
});

test('② 语义寻址（skill-RNA）：目标为描述而非精确名 → 共振最强者命中，semanticAddress=true', () => {
  const ed = new CRISPRSkillEditor({ skillPort: reg(), addressThreshold: 0.3 });
  // 目标描述与 dataClean 的 instructions 高度相关，但与 chartDraw 无关 → 应语义命中 dataClean。
  const rep = ed.edit({
    target: '数据清洗与空值处理',
    patch: (s) => s + '\n语义修订。',
    differentialTest: () => true,
  });
  assert.strictEqual(rep.applied, true);
  assert.strictEqual(rep.semanticAddress, true, '应经语义寻址命中');
  assert.strictEqual(rep.skillName, 'dataClean');
});

test('③ 差异测试失败 → 回滚 fail-closed，绝不提交破损编辑，原技能保持不变', () => {
  const r = reg();
  const ed = new CRISPRSkillEditor({ skillPort: r });
  const before = r.get('dataClean')!.instructions;
  const rep = ed.edit({
    target: 'dataClean',
    patch: (s) => s + '\n危险改写：删除全部数据。',
    differentialTest: () => false, // 脱靶：禁止接受
  });
  assert.strictEqual(rep.applied, false);
  assert.strictEqual(rep.rolledBack, true, '差异测试失败必须回滚');
  assert.strictEqual(rep.reason, 'differential-test-failed');
  assert.strictEqual(r.get('dataClean')!.instructions, before, '原技能不得被破损编辑改写');
  assert.strictEqual(ed.appliedCount(), 0);
});

test('④ 无任何技能命中 → 报告 no-skill-matched，零破坏不抛错', () => {
  const ed = new CRISPRSkillEditor({ skillPort: reg() });
  const rep = ed.edit({ target: '完全不相关的技能XYZ', patch: (s) => s });
  assert.strictEqual(rep.applied, false);
  assert.strictEqual(rep.reason, 'no-skill-matched');
});

test('⑤ 队列 flush：空队列返回空、不误报产出；排入后 flush 批量执行', () => {
  const ed = new CRISPRSkillEditor({ skillPort: reg() });
  assert.deepStrictEqual(ed.flush(), [], '空队列 flush 应返回空数组');
  ed.queue({ target: 'dataClean', patch: (s) => s + '\nQ', differentialTest: () => true });
  ed.queue({ target: 'chartDraw', patch: (s) => s + '\nQ', differentialTest: () => true });
  const out = ed.flush();
  assert.strictEqual(out.length, 2);
  assert.ok(out.every((r) => r.applied === true));
});
