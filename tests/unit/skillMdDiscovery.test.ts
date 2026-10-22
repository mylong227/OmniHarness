/** SKILL.md 工作区自动发现判据（INT-04，2026-10-21）。 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillMdDiscovery } from '../../src/skill/skillMdDiscovery.ts';

function skill(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n按 ${name} 执行。\n`;
}

test('发现 .omniharness/.claude/.agents 下的 SKILL.md，同名按优先级保留', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-skill-discovery-'));
  const previous = process.env.OMNI_AGENTS_SKILLS;
  process.env.OMNI_AGENTS_SKILLS = '1';
  try {
    mkdirSync(join(root, '.omniharness', 'skills', 'alpha'), { recursive: true });
    mkdirSync(join(root, '.claude', 'skills', 'beta'), { recursive: true });
    mkdirSync(join(root, '.agents', 'skills', 'gamma'), { recursive: true });
    writeFileSync(join(root, '.omniharness', 'skills', 'alpha', 'SKILL.md'), skill('alpha', '甲'));
    writeFileSync(join(root, '.claude', 'skills', 'beta', 'SKILL.md'), skill('beta', '乙'));
    writeFileSync(join(root, '.agents', 'skills', 'gamma', 'SKILL.md'), skill('gamma', '丙'));
    // 同名只保留先扫到的（.omniharness > .claude > .agents）。
    mkdirSync(join(root, '.claude', 'skills', 'alpha'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'alpha', 'SKILL.md'), skill('alpha', '不应覆盖'));
    mkdirSync(join(root, '.agents', 'skills', 'alpha'), { recursive: true });
    writeFileSync(
      join(root, '.agents', 'skills', 'alpha', 'SKILL.md'),
      skill('alpha', '也不应覆盖'),
    );
    // 坏文件跳过，不影响好文件。
    mkdirSync(join(root, '.omniharness', 'skills', 'broken'), { recursive: true });
    writeFileSync(join(root, '.omniharness', 'skills', 'broken', 'SKILL.md'), 'not a skill');

    const found = SkillMdDiscovery.discover(root);
    assert.deepStrictEqual(found.map((entry) => entry.name).sort(), ['alpha', 'beta', 'gamma']);
    assert.strictEqual(found.find((entry) => entry.name === 'alpha')?.description, '甲');
  } finally {
    if (previous === undefined) delete process.env.OMNI_AGENTS_SKILLS;
    else process.env.OMNI_AGENTS_SKILLS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('.agents/skills 默认不扫描（opt-in，避免默认扩大工作区提示注入面）', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-skill-agents-off-'));
  const previous = process.env.OMNI_AGENTS_SKILLS;
  delete process.env.OMNI_AGENTS_SKILLS;
  try {
    mkdirSync(join(root, '.agents', 'skills', 'gamma'), { recursive: true });
    writeFileSync(join(root, '.agents', 'skills', 'gamma', 'SKILL.md'), skill('gamma', '丙'));
    assert.deepStrictEqual(SkillMdDiscovery.discover(root), []);
  } finally {
    if (previous !== undefined) process.env.OMNI_AGENTS_SKILLS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('没有技能目录时返回空数组，不抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-skill-empty-'));
  try {
    assert.deepStrictEqual(SkillMdDiscovery.discover(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
