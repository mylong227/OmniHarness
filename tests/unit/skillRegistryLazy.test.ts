/**
 * A7 惰性技能注册（2026-10-29）：元数据参与检索，选中才读正文。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from '../../src/skill/skillRegistry.ts';
import { SkillMdDiscovery } from '../../src/skill/skillMdDiscovery.ts';

test('registerLazy：list 不含正文；select 时加载一次并缓存', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-registry-lazy-'));
  try {
    const dir = join(root, '.omniharness', 'skills', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      ['---', 'name: demo', 'description: 演示技能', '---', '', '正文步骤 1'].join('\n'),
      'utf8',
    );
    const registry = new SkillRegistry();
    let loads = 0;
    registry.registerLazy(
      { name: 'demo', description: '演示技能', instructions: '', trust: 'workspace' },
      () => {
        loads += 1;
        return SkillMdDiscovery.load(root, 'demo');
      },
    );

    assert.strictEqual(registry.list()[0]?.instructions, '', '注册时不应读正文');
    const selected = registry.selectForPrompt('demo');
    assert.strictEqual(selected.length, 1);
    assert.strictEqual(loads, 1);
    assert.strictEqual(registry.render(selected[0]!), '# 技能：demo\n正文步骤 1');
    assert.strictEqual(loads, 1, '正文只加载一次（已缓存）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
