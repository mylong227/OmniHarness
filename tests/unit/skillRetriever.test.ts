import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillRetriever } from '../../src/skill/skillRetriever.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
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

test('SkillRetriever: 分数地板——只要有任何词面重叠就拿到正分（故生产接线必须带相对阈值）', () => {
  const r = new SkillRetriever();
  // 机理钉（分两层，语料无关）：
  //  ① 零词面重叠 ⇒ 空（BM25 只返回 score>0 的文档，所以「真的毫无交集」是能被挡住的）；
  //  ② 只要有一个**仓库域高频词**重叠 ⇒ 每个含该词的技能都拿到正分，哪怕查询与技能域无关。
  // 真实语料（`defaults/skills/harness-core.json`，13 条中文技能）上②的地板最高到 6.26 分，
  // 而真命中得分中位数 21.21 ⇒ 地板**低于**真命中区间，故不构成混淆、可以翻默认；
  // 但地板确实存在，所以生产接线取「相对阈值过滤档」而不是纯 top-k。完整数字见
  // `evals/skill-routing-ab.mjs` 的 `scoreFloor` 段（打印水位线与 GT 得分分布）。
  const catalog: readonly Skill[] = [
    skill('alpha', ['x'], 'Run the pipeline and record the index.'),
    skill('beta', ['y'], 'Run the migration and record the index.'),
    skill('gamma', ['z'], 'Run the probe and record the index.'),
  ];
  assert.deepEqual(
    r.rank(catalog, '今天天气不错，出去走走', { topK: 3 }),
    [],
    '零词面重叠时必须返回空（不做兜底全返回）',
  );
  const floored = r.rank(catalog, 'the index of my favourite album', { topK: 3 });
  assert.strictEqual(floored.length, 3, '共享高频词 index 时三个技能都拿分——地板由此产生');
  assert.ok(
    floored.every((h) => h.score > 0),
    '地板上的候选都是正分，故无法用「>0」把它们与真命中区分开',
  );
});

test('SkillRegistry.selectForPrompt: 空查询与空注册表都不做兜底全返回', () => {
  const empty = new SkillRegistry();
  assert.deepEqual(empty.selectForPrompt('任意文本'), []);
  const registry = new SkillRegistry();
  for (const s of CATALOG) registry.register(s);
  assert.deepEqual(registry.selectForPrompt('   '), []);
});

test('SkillRegistry.selectForPrompt: 服从预算 maxSkills 与确定性（同输入恒同输出）', () => {
  const registry = new SkillRegistry({ maxSkills: 2, minScoreRatio: 0 });
  for (const s of CATALOG) registry.register(s);
  const text = 'review the pipeline and the sql indexes';
  const first = registry.selectForPrompt(text).map((s) => s.name);
  assert.ok(first.length <= 2, `预算 2 生效，实际 ${String(first.length)}`);
  assert.deepEqual(
    registry.selectForPrompt(text).map((s) => s.name),
    first,
  );
});

test('SkillRegistry.selectForPrompt: 同义改写能召回，而字面 match() 不能（翻默认的核心理由）', () => {
  const registry = new SkillRegistry();
  for (const s of CATALOG) registry.register(s);
  // 不含任何技能名或 tag ⇒ 字面通道必然漏召；但与 workflow-automation **正文**词面重叠
  // （repeatable / unattended / steps）⇒ 相关性可召回。刻意避开 tag 词 `pipeline`/`automation`。
  const query = 'set up an unattended repeatable sequence of steps';
  assert.deepEqual(registry.match(query), [], '字面通道不应命中（同义改写的必然漏召）');
  assert.strictEqual(registry.selectForPrompt(query)[0]?.name, 'workflow-automation');
});

test('SkillRegistry: match() 保留为精确通道，语义与翻默认前逐字等价', () => {
  const registry = new SkillRegistry();
  for (const s of CATALOG) registry.register(s);
  assert.deepEqual(
    registry.match('please run workflow-automation').map((s) => s.name),
    ['workflow-automation'],
  );
  assert.deepEqual(
    registry.match('an unrelated sentence').map((s) => s.name),
    [],
  );
});
