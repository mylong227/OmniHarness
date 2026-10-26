import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SkillMdCodec } from '../../src/skill/skillMdCodec.ts';

test('INT-04：解析 SKILL.md frontmatter 与正文', () => {
  const skill = SkillMdCodec.parse(
    '---\nname: pdf-tools\ndescription: 处理 PDF\ntags: [pdf, docs]\n---\n\n# 用法\n先读再写。\n',
  );
  assert.strictEqual(skill.name, 'pdf-tools');
  assert.strictEqual(skill.description, '处理 PDF');
  assert.deepStrictEqual(skill.tags, ['pdf', 'docs']);
  assert.match(skill.instructions, /先读再写/);
});

test('INT-04：序列化后可再次解析（往返一致）', () => {
  const source = SkillMdCodec.parse('---\nname: a\ndescription: b\n---\nbody');
  const round = SkillMdCodec.parse(SkillMdCodec.serialize(source));
  assert.deepStrictEqual(round, source);
});

test('INT-04：缺字段 fail-closed，不静默造技能', () => {
  assert.throws(() => SkillMdCodec.parse('no frontmatter'), /frontmatter/);
  assert.throws(() => SkillMdCodec.parse('---\nname: x\n---\nbody'), /description/);
});

test('INT-04：gray-matter 可选增强解析 YAML 数组与带冒号的值', () => {
  const skill = SkillMdCodec.parse(
    '---\nname: yaml-skill\ndescription: "处理: PDF"\ntags:\n  - pdf\n  - docs\n---\n\n正文。\n',
  );
  assert.strictEqual(skill.description, '处理: PDF');
  assert.deepStrictEqual(skill.tags, ['pdf', 'docs']);
});

test('INT-04：resources/exclusive 解析、序列化往返', () => {
  const skill = SkillMdCodec.parse(
    '---\nname: browser\ndescription: 浏览器\ntags: [web]\nresources: [browser, port:5173]\nexclusive: true\n---\n正文',
  );
  assert.deepStrictEqual(skill.resources, ['browser', 'port:5173']);
  assert.strictEqual(skill.exclusive, true);
  const round = SkillMdCodec.parse(SkillMdCodec.serialize(skill));
  assert.deepStrictEqual(round.resources, skill.resources);
  assert.strictEqual(round.exclusive, true);
});
