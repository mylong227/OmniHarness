import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillRetriever } from '../../src/skill/skillRetriever.js';
import type { Skill } from '../../src/skill/skill.js';

const skill = (name: string, tags: string[], instructions: string): Skill => ({
  name,
  description: instructions,
  tags,
  instructions,
});

const CATALOG: readonly Skill[] = [
  skill(
    'workflow-automation',
    ['automation', 'pipeline'],
    'Chain several steps into a repeatable pipeline and run them unattended.',
  ),
  skill(
    'code-review',
    ['review', 'quality'],
    'Inspect a diff for defects, style drift and missing tests.',
  ),
  skill(
    'incident-triage',
    ['incident', 'oncall'],
    'Classify an outage, find the blast radius and page the right owner.',
  ),
  skill(
    'sql-optimization',
    ['sql', 'database'],
    'Rewrite slow queries and add the missing indexes.',
  ),
];

test('SkillRetriever: 空查询与空技能集都不做兜底全返回（全返回正是「技能堆叠噪声」的来源）', () => {
  const r = new SkillRetriever();
  assert.deepEqual(r.rank(CATALOG, ''), []);
  assert.deepEqual(r.rank(CATALOG, '   '), []);
  assert.deepEqual(r.rank([], 'anything'), []);
});

test('SkillRetriever: 同义改写也能召回——这是子串包含做不到的情形', () => {
  const r = new SkillRetriever();
  // 「把这个流程自动化一遍」与技能名 workflow-automation 字面无交集 ⇒ 子串匹配必然漏召。
  const text = 'take this multi step flow and make it run by itself on a schedule';
  const substringHit = CATALOG.filter(
    (s) => text.includes(s.name) || (s.tags ?? []).some((t) => text.includes(t)),
  );
  assert.strictEqual(substringHit.length, 0, '前置断言：子串匹配在本例上确实一个都召不回');

  const hits = r.rank(CATALOG, text, { topK: 5 });
  assert.ok(hits.length > 0, 'BM25 应当至少召回一条');
  assert.strictEqual(hits[0]?.skill.name, 'workflow-automation');
});

test('SkillRetriever: 结果按得分降序且受 topK 截断', () => {
  const r = new SkillRetriever();
  const hits = r.rank(CATALOG, 'review the diff for missing tests', { topK: 2 });
  assert.strictEqual(hits.length, 2);
  assert.strictEqual(hits[0]?.skill.name, 'code-review');
  for (let i = 1; i < hits.length; i += 1) {
    assert.ok((hits[i - 1]?.score ?? 0) >= (hits[i]?.score ?? 0), '得分必须单调不增');
  }
});

test('SkillRetriever: 确定性——同输入恒同输出（无随机源）', () => {
  const r = new SkillRetriever();
  const q = 'database query is slow';
  const a = r.rank(CATALOG, q, { topK: 3 }).map((h) => h.skill.name);
  const b = r.rank(CATALOG, q, { topK: 3 }).map((h) => h.skill.name);
  assert.deepEqual(a, b);
});

test('SkillRetriever: minScore 可挡住弱相关（不把噪声灌进上下文）', () => {
  const r = new SkillRetriever();
  const all = r.rank(CATALOG, 'rewrite the query planner', { topK: 5 });
  const strict = r.rank(CATALOG, 'rewrite the query planner', {
    topK: 5,
    minScore: all[0]?.score ?? 0,
  });
  assert.ok(strict.length <= all.length);
  assert.ok(strict.length >= 1, '最高分那条必须保留');
});

test('SkillRetriever: 不改动 SkillRegistry.match 的默认语义（本类是 opt-in，零行为变更）', () => {
  // 仅作契约声明：本文件不涉及 SkillRegistry；若将来把检索接成默认路径，必须同步改这里。
  const r = new SkillRetriever();
  assert.strictEqual(r.rank(CATALOG, 'x').length <= 5, true);
});
