// T5.4（技能稀疏化）可证伪验收：
//   ① 命中强度评分：名字精确 > 名字子串 > 标签（逐级可复算）；
//   ② 预算截断：> maxSkills 时按得分从低往高剪（弱命中长尾出局，噪声下降）；
//   ③ 强命中豁免：名字命中级（score ≥ 3）即使超出预算也保留（成功率不降的机制保障）；
//   ④ 确定性：同输入重复稀疏化 20 次结果完全一致（同分按名称字典序，无随机源）；
//   ⑤ 空输入与单元素边界不抛错。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SkillSparsifier } from '../../src/skill/skillSparsifier.js';
import type { Skill } from '../../src/skill/skill.js';

function skill(name: string, tags?: readonly string[]): Skill {
  return {
    name,
    instructions: `instructions-of-${name}`,
    ...(tags ? { tags } : {}),
  } as Skill;
}

test('① 命中强度评分：精确 4 > 子串 3 > 标签 1..2', () => {
  const sp = new SkillSparsifier();
  assert.strictEqual(sp.hitScore(skill('code-review'), 'code-review'), 4, '全文等值即精确命中');
  assert.strictEqual(sp.hitScore(skill('review'), '请运行 code-review 技能'), 3, '名字子串命中');
  assert.strictEqual(sp.hitScore(skill('deploy'), '请检查 ci 与 release 流程'), 0, '无命中');
  assert.strictEqual(
    sp.hitScore(skill('ship', ['ci', 'release']), '请检查 ci 与 release 流程'),
    2,
    '双标签命中封顶 2',
  );
  assert.strictEqual(sp.hitScore(skill('ship', ['ci']), '请检查 ci 流程'), 1, '单标签命中');
});

test('② 预算截断：标签级弱命中按得分从低往高剪（噪声下降）', () => {
  const sp = new SkillSparsifier({ maxSkills: 2, minKeepScore: 3 });
  const r = sp.sparsify(
    [
      skill('weak-a', ['alpha']),
      skill('weak-b', ['beta']),
      skill('weak-c', ['gamma']),
      skill('weak-d', ['delta']),
    ],
    '关于 alpha 与 gamma 的任务',
  );
  assert.deepStrictEqual(r.kept.map((s) => s.name).sort(), ['weak-a', 'weak-c'], '命中者保留');
  assert.deepStrictEqual(
    r.dropped.map((s) => s.name).sort(),
    ['weak-b', 'weak-d'],
    '未命中的长尾被剪（上下文噪声下降）',
  );
});

test('③ 强命中豁免：名字命中即使超出预算也保留（成功率不降保障）', () => {
  const sp = new SkillSparsifier({ maxSkills: 2 });
  const r = sp.sparsify(
    [skill('weak-1', ['t1']), skill('core-a'), skill('core-b'), skill('core-c')],
    '依次执行 core-a core-b core-c 并参考 t1',
  );
  // core-a/core-b 占满预算；core-c 是名字命中（score 3 ≥ 下限）→ 预算外豁免；weak-1 标签级被剪。
  assert.deepStrictEqual(r.kept.map((s) => s.name).sort(), ['core-a', 'core-b', 'core-c']);
  assert.ok(r.kept.length > 2, 'kept 超过 maxSkills 是预期行为（强命中豁免）');
  assert.deepStrictEqual(
    r.dropped.map((s) => s.name),
    ['weak-1'],
    '标签级弱命中被剪',
  );
});

test('④ 确定性：同输入重复 20 次结果完全一致（同分按名称字典序）', () => {
  const sp = new SkillSparsifier({ maxSkills: 2, minKeepScore: 3 });
  const matched = [skill('b-tag', ['x']), skill('a-tag', ['x']), skill('c-core'), skill('a-core')];
  const run = () => {
    const r = sp.sparsify(matched, '关于 a-core 与 c-core 的任务');
    return {
      kept: r.kept.map((s) => s.name),
      dropped: r.dropped.map((s) => s.name),
    };
  };
  const first = run();
  for (let i = 0; i < 19; i++) assert.deepStrictEqual(run(), first, '同输入必须恒同结果');
  assert.deepStrictEqual(first.kept, ['a-core', 'c-core'], '同分按字典序；标签级命中不豁免');
});

test('⑤ 边界：空输入与单元素不抛错', () => {
  const sp = new SkillSparsifier();
  assert.deepStrictEqual(sp.sparsify([], 'anything').kept, []);
  const one = sp.sparsify([skill('solo')], 'solo');
  assert.strictEqual(one.kept.length, 1);
  assert.strictEqual(one.dropped.length, 0);
});

test('⑥ 相关性主序：给了 relevance 就按相关性排，命中强度只作同分次序（§3-5 回归判据）', () => {
  const sp = new SkillSparsifier({ maxSkills: 2, minKeepScore: 3 });
  // 相关性序把「名字命中、但相关性最低」的 core-z 排在最后：预算 2 先被相关性最高的两条占满。
  const relevance = new Map([
    ['weak-b', 30],
    ['weak-a', 20],
    ['core-z', 1],
  ]);
  const r = sp.sparsify(
    [skill('core-z'), skill('weak-a', ['t']), skill('weak-b', ['t'])],
    '请执行 core-z 任务',
    relevance,
  );
  assert.deepStrictEqual(
    r.kept.map((s) => s.name),
    ['weak-b', 'weak-a', 'core-z'],
    '顺序由相关性决定；core-z 因名字命中豁免（score 3）而在预算外仍保留',
  );
  assert.deepStrictEqual(r.dropped, [], '强命中豁免生效 ⇒ 无被剪项');
});

test('⑦ 未给 relevance 时逐字保持旧行为（同分按名称字典序）', () => {
  const sp = new SkillSparsifier({ maxSkills: 2, minKeepScore: 3 });
  const r = sp.sparsify([skill('b-x', ['t']), skill('a-x', ['t'])], 't');
  assert.deepStrictEqual(
    r.kept.map((s) => s.name),
    ['a-x', 'b-x'],
  );
});

test('⑧ 上游若预先截断，预算与豁免判据必然退化（钉住「不得预截断」这条契约）', () => {
  const sp = new SkillSparsifier({ maxSkills: 5, minKeepScore: 3 });
  // 只有 5 条候选（= maxSkills）⇒ 全部保留，豁免分支永远不会被触发。
  const preTruncated = ['s1', 's2', 's3', 's4', 's5'].map((name) => skill(name));
  const r = sp.sparsify(preTruncated, '无关提示');
  assert.strictEqual(r.kept.length, 5);
  assert.strictEqual(r.dropped.length, 0, '预截断后预算恒不超 ⇒ 稀疏化器退化为恒等变换');
});
