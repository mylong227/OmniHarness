// (P2, I-P2-5) CapabilityCrystallizer 单元测试：经验密度越阈 → 常用组合冻结为原生能力（加法式、fail-closed）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Skill } from '../../src/skill/skill.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import { CapabilityCrystallizer } from '../../src/adapters/skill/capabilityCrystallizer.js';

const a: Skill = { name: 'a', description: 'A', instructions: '做 A。' };
const b: Skill = { name: 'b', description: 'B', instructions: '做 B。' };
const c: Skill = { name: 'c', description: 'C', instructions: '做 C。' };

function reg(): SkillRegistry {
  const r = new SkillRegistry();
  r.register(a);
  r.register(b);
  r.register(c);
  return r;
}

test('① 密度低于阈值不冻结；越过阈值冻结为原生能力，density 归零', () => {
  const r = reg();
  const cc = new CapabilityCrystallizer({ skillPort: r, densityThreshold: 3 });
  cc.observe(['a', 'b']);
  assert.strictEqual(cc.density(['a', 'b']), 1);
  assert.deepStrictEqual(cc.crystallize().frozen, [], '低于阈值不应冻结');
  cc.observe(['a', 'b']);
  cc.observe(['a', 'b']); // 累计到 3
  assert.strictEqual(cc.density(['a', 'b']), 3);
  const rep = cc.crystallize();
  assert.strictEqual(rep.frozen.length, 1, '越过阈值应冻结 1 条');
  const frozenName = rep.frozen[0]!;
  const frozen = cc.frozen()[0]!;
  assert.strictEqual(frozen.name, frozenName);
  assert.deepStrictEqual(frozen.from, ['a', 'b']);
  assert.strictEqual(r.get(frozenName)?.frozen, true, '冻结能力应注册为原生技能且标记 frozen');
  assert.strictEqual(cc.density(['a', 'b']), 0, '越阈后密度应归零（序参量回落）');
});

test('② 已冻结组合再次 crystallize → 计 alreadyFrozen，不重复注册（冻结清单长度稳定）', () => {
  const cc = new CapabilityCrystallizer({ skillPort: reg(), densityThreshold: 2 });
  cc.observe(['a', 'b']);
  cc.observe(['a', 'b']);
  const first = cc.crystallize();
  assert.strictEqual(first.frozen.length, 1);
  const frozenLen = cc.frozen().length;
  // 继续观测同一 combo 并再次固化。
  cc.observe(['a', 'b']);
  cc.observe(['a', 'b']);
  const second = cc.crystallize();
  assert.strictEqual(second.alreadyFrozen, 1, '已冻结组合应计 alreadyFrozen');
  assert.strictEqual(second.frozen.length, 0, '不应重复冻结');
  assert.strictEqual(cc.frozen().length, frozenLen, '冻结清单长度应保持稳定');
});

test('③ 组合含缺失技能 → 跳过 fail-closed，不抛错、不静默编造', () => {
  const cc = new CapabilityCrystallizer({ skillPort: reg(), densityThreshold: 1 });
  cc.observe(['a', 'ghost']); // ghost 不在注册表
  cc.observe(['a', 'ghost']);
  cc.observe(['a', 'ghost']);
  const rep = cc.crystallize();
  assert.strictEqual(rep.frozen.length, 0);
  assert.strictEqual(rep.skipped.length, 1, '缺失成员的 combo 应计入 skipped');
});

test('④ 加法式铁律：冻结不删改源组合，原技能仍可用', () => {
  const r = reg();
  const cc = new CapabilityCrystallizer({ skillPort: r, densityThreshold: 2 });
  cc.observe(['a', 'b']);
  cc.observe(['a', 'b']);
  cc.crystallize();
  assert.ok(r.get('a') !== undefined && r.get('b') !== undefined, '源组合技能不得被删除/改写');
  assert.strictEqual(r.get('a')!.instructions, '做 A。', '源技能内容保持原样');
});
