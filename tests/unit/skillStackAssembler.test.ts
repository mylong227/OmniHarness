import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SkillStackAssembler } from '../../src/config/skillStackAssembler.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import type { Skill } from '../../src/skill/skill.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';

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
