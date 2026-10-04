/**
 * Wave B1（ADR-0009）：首个资产类型描述符 `SkillSchema` 的判据。
 *
 * 判据口径：
 * - 校验正例与四类负例（非对象 / 字段缺失或空 / 字段类型错 / tags 非法）齐备；
 * - 类型描述符字段如实（kind / 版本 / 默认信任档 / 默认隔离档 / 台账语义）；
 * - **评估尺与门禁同源**：`evalContract` 与 `Benchmark.moireEnergy(skill, 64)` 逐位相同
 *   （断言字面量，不断言常量——常量改了判据必须红）。
 *
 * 变异自证：让 `validate` 恒返回 ok ⇒ 负例全红；把基准换成别的场边长 ⇒ 同源判据红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SkillSchema } from '../../src/capability/schemas/skillSchema.js';
import { Benchmark } from '../../src/evolution/benchmark.js';
import type { Skill } from '../../src/skill/skill.js';

/**
 * 造一个最小合法技能。
 * @param name 技能名
 * @returns Skill
 */
function skillOf(name: string): Skill {
  return { name, description: `${name} 描述`, instructions: `${name} 步骤。`, tags: [name] };
}

test('B1 SkillSchema：校验正例与四类负例（非对象 / 缺失或空 / 类型错 / tags 非法）', () => {
  const schema = new SkillSchema();
  assert.deepStrictEqual(schema.validate(skillOf('a')), { ok: true }, '最小合法技能通过');
  assert.deepStrictEqual(
    schema.validate({ name: 'a', description: 'd', instructions: 'i' }),
    { ok: true },
    'tags 可省略',
  );

  const cases: readonly { readonly asset: unknown; readonly match: RegExp }[] = [
    { asset: null, match: /必须是对象/ },
    { asset: 'not-an-asset', match: /必须是对象/ },
    { asset: { description: 'd', instructions: 'i' }, match: /字段 name 缺失或为空/ },
    { asset: { name: 'a', description: '   ', instructions: 'i' }, match: /字段 description/ },
    { asset: { name: 'a', description: 'd', instructions: 42 }, match: /字段 instructions/ },
    {
      asset: { name: 'a', description: 'd', instructions: 'i', tags: 'not-array' },
      match: /tags 必须是字符串数组/,
    },
    {
      asset: { name: 'a', description: 'd', instructions: 'i', tags: ['ok', 7] },
      match: /tags 必须是字符串数组/,
    },
  ];
  for (const { asset, match } of cases) {
    const verdict = schema.validate(asset);
    assert.strictEqual(verdict.ok, false, `非法资产必须被拒：${JSON.stringify(asset)}`);
    if (!verdict.ok) assert.match(verdict.reason, match);
  }
});

test('B1 SkillSchema：类型描述符字段如实（kind / 版本 / 默认档 / 台账语义）', () => {
  const schema = new SkillSchema();
  assert.strictEqual(schema.kind, 'skill');
  assert.strictEqual(schema.version, 1);
  assert.strictEqual(schema.defaultTrustTier, 'core');
  assert.strictEqual(schema.defaultIsolation, 'os-sandbox');
  assert.deepStrictEqual(schema.ledgerSemantics, {
    chain: 'promotion',
    snapshot: 'registry-full',
  });
});

test('B1 评估尺同源：evalContract 与门禁基准逐位相同（断言字面量，不断言常量）', () => {
  const schema = new SkillSchema();
  const bench = schema.evalContract({ evaluator: 'test' });
  const skill = skillOf('alpha');
  const expected = Benchmark.moireEnergy(skill, 64);
  assert.ok(expected > 0, '参照值本身必须非 0（否则「相等」无意义）');
  assert.strictEqual(
    bench(skill),
    expected,
    '技能基准必须与 Benchmark.moireEnergy @ n=64 逐位相同',
  );
  assert.strictEqual(
    SkillSchema.benchmarkOf(skill),
    expected,
    '静态入口与契约入口同值（单一实现点）',
  );
  assert.strictEqual(bench(null), 0, '非法资产恒 0（fail-closed：评估不了不给中间分）');
  assert.strictEqual(bench({ name: 'x', description: 'd', instructions: '' }), 0);
});
