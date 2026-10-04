/**
 * Wave B1（ADR-0009 · EVOLVIX_SPEC §2）：资产类型注册表判据。
 *
 * 失败语义的**两条 fail-closed** 是判据核心（都是「抛」而不是「默认值」）：
 * - 重复 `kind` 注册 ⇒ 抛（静默覆盖会让已入库资产的校验口径变形）；
 * - 未注册 `kind` 查询 ⇒ 抛（返回 `undefined` 会诱导调用方「跳过校验」，正是 J7 的入口）。
 *
 * 变异自证：去掉 `register` 的重复检查、把 `schemaOf` 改成返回 `undefined`、把 `kinds()` 改成插入序
 * ⇒ 相应用例必须红（三条都试过，见提交说明）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilitySchemaRegistry } from '../../src/capability/capabilitySchemaRegistry.js';
import type { CapabilitySchema } from '../../src/ports/capability.js';

/**
 * 造一个「只关心 kind」的桩类型描述符。
 * @param kind 类型键
 * @returns CapabilitySchema（校验恒过、基准恒 0）
 */
function stubSchema(kind: string): CapabilitySchema {
  return {
    kind,
    version: 1,
    validate: () => ({ ok: true }),
    evalContract: () => () => 0,
    defaultTrustTier: 'core',
    defaultIsolation: 'in-process',
    ledgerSemantics: { chain: 'promotion', snapshot: 'registry-full' },
  };
}

test('B1 注册表：重复 kind 即拒（不静默覆盖）', () => {
  const registry = new CapabilitySchemaRegistry();
  registry.register(stubSchema('skill'));
  assert.throws(() => registry.register(stubSchema('skill')), /资产类型重复注册: skill/);
  assert.strictEqual(registry.kinds().length, 1, '被拒的注册不得改变注册表状态');
});

test('B1 注册表：未注册 kind 即拒（不返回 undefined 诱导跳过校验）', () => {
  const registry = new CapabilitySchemaRegistry();
  registry.register(stubSchema('skill'));
  assert.throws(() => registry.schemaOf('workflow-template'), /资产类型未注册: workflow-template/);
  assert.strictEqual(registry.has('skill'), true);
  assert.strictEqual(registry.has('workflow-template'), false, 'has 只回答事实，不做兜底');
});

test('B1 注册表：kinds() 升序且与注册序无关（确定性）', () => {
  const forward = new CapabilitySchemaRegistry();
  for (const kind of ['skill', 'operator', 'workflow-template']) forward.register(stubSchema(kind));
  const backward = new CapabilitySchemaRegistry();
  for (const kind of ['workflow-template', 'operator', 'skill'])
    backward.register(stubSchema(kind));
  assert.deepStrictEqual(forward.kinds(), ['operator', 'skill', 'workflow-template']);
  assert.deepStrictEqual(backward.kinds(), forward.kinds(), '列举口径与注册顺序无关');
});

test('B1 注册表：schemaOf 返回注册时那一个描述符（同引用，不做包装/克隆）', () => {
  const registry = new CapabilitySchemaRegistry();
  const schema = stubSchema('skill');
  registry.register(schema);
  assert.strictEqual(registry.schemaOf('skill'), schema);
});
