/**
 * A7 两阶段技能发现（2026-10-29）：`list()` 只出元数据，`load()` 才取正文。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillMdDiscovery } from '../../src/skill/skillMdDiscovery.ts';

test('list 不返回正文；load 按名取回完整技能（trust=workspace）', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-lazy-'));
  try {
    const dir = join(root, '.omniharness', 'skills', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      ['---', 'name: demo', 'description: 演示技能', 'tags: [a, b]', '---', '', '正文步骤 1'].join(
        '\n',
      ),
      'utf8',
    );

    const listed = SkillMdDiscovery.list(root);
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0]?.name, 'demo');
    assert.strictEqual(listed[0]?.trust, 'workspace');
    assert.strictEqual(Object.hasOwn(listed[0] ?? {}, 'instructions'), false, '阶段一不得携带正文');
    assert.ok((listed[0]?.file ?? '').includes('SKILL.md'));

    const loaded = SkillMdDiscovery.load(root, 'demo');
    assert.strictEqual(loaded?.instructions, '正文步骤 1');
    assert.deepStrictEqual(loaded?.tags, ['a', 'b']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('load：未知技能返回 undefined', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-lazy-'));
  try {
    assert.strictEqual(SkillMdDiscovery.load(root, 'missing'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
