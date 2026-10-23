import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SkillStackAssembler } from '../../src/config/skillStackAssembler.ts';
import { ConfigFactory } from '../../src/config/configFactory.ts';
import { MockModel } from '../../src/adapters/model/mockModel.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import type { Skill } from '../../src/skill/skill.ts';
import type { OmniHarnessConfig } from '../../src/config/configFactory.ts';

/** 构造最小可解析配置（mock 适配器，无网络）。 */
function base(over: Partial<OmniHarnessConfig> = {}): OmniHarnessConfig {
  return {
    workspaceRoot: process.cwd(),
    maxSteps: 4,
    model: new MockModel(),
    storage: new MemoryStorage(),
    ...over,
  };
}

/** 示例技能（受种进注册表用）。 */
const SAMPLE_SKILL: Skill = {
  name: 'demo',
  description: '示例技能',
  instructions: '按示例执行',
};

test('技能栈：缺省仅空注册表，各算子旁路', () => {
  const stack = SkillStackAssembler.assembleSkillStack(base());
  assert.strictEqual(stack.skillRegistry.list().length, 0);
  assert.strictEqual(stack.crispr, undefined);
  assert.strictEqual(stack.crystallizer, undefined);
  assert.strictEqual(stack.etching, undefined);
  assert.strictEqual(stack.elementComposerEngine, undefined);
  assert.strictEqual(stack.symmetry, undefined);
  assert.strictEqual(stack.confinementEngine, undefined);
});

test('技能栈：受种技能池进注册表', () => {
  const stack = SkillStackAssembler.assembleSkillStack(base({ skills: [SAMPLE_SKILL] }));
  assert.strictEqual(stack.skillRegistry.list().length, 1);
  assert.strictEqual(stack.skillRegistry.get('demo')?.name, 'demo');
});

test('技能栈：各算子按开关构造且共享同一注册表', () => {
  const stack = SkillStackAssembler.assembleSkillStack(
    base({
      skills: [SAMPLE_SKILL],
      skillEditing: { enabled: true },
      capabilityCrystallization: { enabled: true },
      insightEtching: { enabled: true },
      elementComposer: { enabled: true },
      symmetryBreaking: { enabled: true },
      confinement: { enabled: true },
    }),
  );
  assert.ok(stack.crispr !== undefined);
  assert.ok(stack.crystallizer !== undefined);
  assert.ok(stack.etching !== undefined);
  assert.ok(stack.elementComposerEngine !== undefined);
  assert.ok(stack.symmetry !== undefined);
  assert.ok(stack.confinementEngine !== undefined);
  // 编辑—固化面对同一份技能状态：注册表恒为受种的那一份。
  assert.strictEqual(stack.skillRegistry.list().length, 1);
});

test('workspace trust：未信任工作区不自动发现项目 SKILL.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-skill-trust-'));
  try {
    mkdirSync(join(root, '.claude', 'skills', 'project'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'skills', 'project', 'SKILL.md'),
      '---\nname: project\ndescription: 项目技能\n---\n\n执行。\n',
    );
    const untrusted = SkillStackAssembler.assembleSkillStack(
      base({ workspaceRoot: root, allowWorkspaceSkills: false }),
    );
    assert.strictEqual(untrusted.skillRegistry.get('project'), undefined);
    const trusted = SkillStackAssembler.assembleSkillStack(
      base({ workspaceRoot: root, allowWorkspaceSkills: true }),
    );
    assert.ok(trusted.skillRegistry.get('project') !== undefined);
    // 装配字面量必须透传该安全字段（否则 switchWorkspace/ConfigFactory 调用方静默丢失信任决定）。
    const assembled = ConfigFactory.build(
      base({ workspaceRoot: root, allowWorkspaceSkills: false }),
    );
    assert.strictEqual(assembled.allowWorkspaceSkills, false);
    assert.strictEqual(assembled.skillRegistry.get('project'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
