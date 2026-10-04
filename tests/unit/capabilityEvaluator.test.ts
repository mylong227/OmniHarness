/**
 * Wave B4：通用资产评估器 `CapabilityEvaluator` 的判据。
 *
 * 判据口径（诚实分级，与 Wave A 的可验证奖励同一条线）：
 * - 类型未注册 ⇒ `unverifiable:no-schema:<kind>`（**不是判负**，是「没验过」）；
 * - 契约抛错 ⇒ `unverifiable:contract-error:<原因>`；
 * - 契约返回非有限数 ⇒ `unverifiable:non-finite`（脏数字不当分数）；
 * - 正常量出 ⇒ `verified:<kind>`，reward = 该类型声明的度量值（**判低分也是判定**）。
 *
 * 另钉两条纪律：度量口径**来自类型声明**（同一资产换 schema ⇒ 换分），
 * 且 `fitnessOf` 在不可验证时**不产伪适应度**（undefined）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityEvaluator } from '../../src/capability/capabilityEvaluator.js';
import { CapabilitySchemaRegistry } from '../../src/capability/capabilitySchemaRegistry.js';
import { SkillSchema } from '../../src/capability/schemas/skillSchema.js';
import type { CapabilityRecord, CapabilitySchema } from '../../src/ports/capability.js';

/**
 * 造一条资产记录。
 * @param asset 资产本体
 * @param schemaKind 类型键
 * @returns CapabilityRecord
 */
function recordOf(asset: unknown, schemaKind: string): CapabilityRecord {
  return {
    asset,
    schemaKind,
    lineage: { parents: [], operator: 'test', bornAt: '2026-10-04T00:00:00.000Z' },
    fitness: undefined,
    governance: {
      trustTier: 'core',
      isolation: 'in-process',
      state: 'active',
      ledgerSeq: undefined,
    },
  };
}

/**
 * 造一个指定度量行为的桩类型。
 * @param kind 类型键
 * @param score 度量函数
 * @returns CapabilitySchema
 */
function stubSchema(
  kind: string,
  score: (asset: unknown) => number | Promise<number>,
): CapabilitySchema {
  return {
    kind,
    version: 1,
    validate: () => ({ ok: true }),
    evalContract: () => score,
    defaultTrustTier: 'core',
    defaultIsolation: 'in-process',
    ledgerSemantics: { chain: 'promotion', snapshot: 'registry-full' },
  };
}

test('B4 评估器：类型未注册 ⇒ unverifiable（「没验过」不冒充「验过」）', async () => {
  const schemas = new CapabilitySchemaRegistry();
  const evaluator = new CapabilityEvaluator({ schemas });
  assert.deepStrictEqual(await evaluator.evaluate(recordOf({ anything: true }, 'insight')), {
    reward: 0,
    verifiable: false,
    reason: 'unverifiable:no-schema:insight',
  });
});

test('B4 评估器：契约抛错与非有限数都归 unverifiable（fail-closed，原因可读）', async () => {
  const schemas = new CapabilitySchemaRegistry();
  schemas.register(
    stubSchema('boom', () => {
      throw new Error('契约崩了');
    }),
  );
  schemas.register(stubSchema('nan', () => Number.NaN));
  schemas.register(stubSchema('inf', () => Number.POSITIVE_INFINITY));
  const evaluator = new CapabilityEvaluator({ schemas });

  assert.deepStrictEqual(await evaluator.evaluate(recordOf({}, 'boom')), {
    reward: 0,
    verifiable: false,
    reason: 'unverifiable:contract-error:契约崩了',
  });
  assert.strictEqual(
    (await evaluator.evaluate(recordOf({}, 'nan'))).reason,
    'unverifiable:non-finite',
  );
  assert.strictEqual(
    (await evaluator.evaluate(recordOf({}, 'inf'))).reason,
    'unverifiable:non-finite',
  );
});

test('B4 评估器：正常量出 ⇒ verified + 度量值；异步契约同样支持', async () => {
  const schemas = new CapabilitySchemaRegistry();
  schemas.register(new SkillSchema());
  schemas.register(stubSchema('async-kind', async () => 0.25));
  const evaluator = new CapabilityEvaluator({ schemas, evaluator: 'b4' });

  const skill = { name: 's1', description: 'd', instructions: 'i' };
  const verdict = await evaluator.evaluate(recordOf(skill, 'skill'));
  assert.strictEqual(verdict.verifiable, true);
  assert.strictEqual(verdict.reason, 'verified:skill');
  assert.strictEqual(verdict.reward, SkillSchema.benchmarkOf(skill as never));

  const asyncVerdict = await evaluator.evaluate(recordOf({}, 'async-kind'));
  assert.deepStrictEqual(asyncVerdict, {
    reward: 0.25,
    verifiable: true,
    reason: 'verified:async-kind',
  });
});

test('B4 评估器：度量口径来自类型声明（同一资产换类型 ⇒ 换分），且不可验证时不产伪适应度', async () => {
  const schemas = new CapabilitySchemaRegistry();
  schemas.register(stubSchema('zero', () => 0));
  schemas.register(stubSchema('one', () => 1));
  const evaluator = new CapabilityEvaluator({ schemas });

  const asset = { name: 'x' };
  assert.strictEqual((await evaluator.evaluate(recordOf(asset, 'zero'))).reward, 0);
  assert.strictEqual((await evaluator.evaluate(recordOf(asset, 'one'))).reward, 1);

  assert.deepStrictEqual(
    await evaluator.fitnessOf(recordOf(asset, 'zero'), '2026-10-04T00:00:00.000Z'),
    {
      benchmark: 0,
      evaluatedAt: '2026-10-04T00:00:00.000Z',
      evaluator: 'capability-evaluator',
    },
  );
  assert.strictEqual(
    await evaluator.fitnessOf(recordOf(asset, 'missing-kind'), '2026-10-04T00:00:00.000Z'),
    undefined,
    '不可验证 ⇒ 不写适应度（绝不产伪数据）',
  );
});
