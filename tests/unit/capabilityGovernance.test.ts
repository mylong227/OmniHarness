/**
 * Wave B3（ADR-0009 · EVOLVIX_SPEC §2 失败语义 + §8 J7）：注册口与治理的 **fail-closed** 判据。
 *
 * 三条判据，每条都对应一句可证伪的声明：
 * 1. **未注册类型即拒、结构非法即拒**（J7）——且**失败不留痕**（不「先收下再回滚」）；
 *    变异：把 `put` 里的 `validate` 去掉 ⇒ 非法资产入册，本用例立刻红。
 * 2. **治理变更必须留台账**——无台账时变更被拒且状态不变；有台账时入链并回写 `ledgerSeq`，
 *    链验签仍绿（治理事件不隐身）。
 * 3. **档位只可收紧不可放宽**——信任档/隔离档按全序只许朝更严走；放宽即抛（不静默忽略）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/capability/capabilityRegistry.js';
import { CapabilitySchemaRegistry } from '../../src/capability/capabilitySchemaRegistry.js';
import { SkillSchema } from '../../src/capability/schemas/skillSchema.js';
import { HashChainPromotionLedger } from '../../src/evolution/hashChainPromotionLedger.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import type { CapabilityRecord } from '../../src/ports/capability.js';
import type { Skill } from '../../src/skill/skill.js';

/**
 * 造一条技能资产记录。
 * @param name 资产名
 * @returns CapabilityRecord
 */
function recordOf(name: string): CapabilityRecord {
  const asset: Skill = { name, description: `${name} 描述`, instructions: `${name} 步骤。` };
  return {
    asset,
    schemaKind: 'skill',
    lineage: { parents: [], operator: 'test', bornAt: '2026-10-04T00:00:00.000Z' },
    fitness: undefined,
    governance: {
      trustTier: 'core',
      isolation: 'os-sandbox',
      state: 'active',
      ledgerSeq: undefined,
    },
  };
}

/**
 * 建一个注册表（可带台账）。
 * @param withLedger 是否注入台账
 * @returns 注册表与（可选）台账
 */
function build(withLedger: boolean): {
  readonly registry: CapabilityRegistry;
  readonly ledger?: HashChainPromotionLedger;
} {
  const schemas = new CapabilitySchemaRegistry();
  schemas.register(new SkillSchema());
  if (!withLedger) return { registry: new CapabilityRegistry({ schemas }) };
  const ledger = new HashChainPromotionLedger({ now: () => '2026-10-04T00:00:00.000Z' });
  return {
    registry: new CapabilityRegistry({ schemas, skills: new SkillRegistry(), ledger }),
    ledger,
  };
}

test('B3 J7 未注册类型即拒：注册口不认「先收下再想办法」，且失败不留痕', () => {
  const { registry } = build(false);
  const record = recordOf('op-seed');
  assert.throws(
    () => registry.put({ ...record, schemaKind: 'operator' }),
    /资产类型未注册: operator/,
    '未注册类型必须被拒（变异：去掉 schemaOf 把关 ⇒ 本断言红）',
  );
  assert.strictEqual(registry.recordOf('op-seed'), undefined, '被拒的入册不得留痕');
  assert.deepStrictEqual(registry.recordsOfKind('operator'), []);
});

test('B3 J7 结构非法即拒：校验由类型作者声明，注册口按声明执行（变异：去掉 validate ⇒ 红）', () => {
  const { registry } = build(false);
  const invalid = {
    ...recordOf('bad'),
    asset: { name: '', description: 'd', instructions: 'i' },
  };
  assert.throws(
    () => registry.put(invalid),
    /资产校验不通过（skill）：技能字段 name 缺失或为空/,
    '非法资产必须被拒且原因可行动（变异：绕过校验 ⇒ 本断言红）',
  );
  assert.strictEqual(registry.get('bad'), undefined, '被拒资产不得落进技能表');
  assert.strictEqual(registry.recordOf('bad'), undefined);

  const notObject = { ...recordOf('bad2'), asset: 42 };
  assert.throws(() => registry.put(notObject), /资产校验不通过（skill）：技能资产必须是对象/);
});

test('B3 治理变更必须留台账：无台账即拒且状态不变（无账不生效）', () => {
  const { registry } = build(false);
  registry.put(recordOf('a'));
  assert.throws(
    () => registry.setGovernance('a', { trustTier: 'evolved' }),
    /治理变更被拒（无台账不生效）: a/,
  );
  assert.strictEqual(
    registry.recordOf('a')?.governance.trustTier,
    'core',
    '被拒的变更不得改状态（fail-closed 是「拒」不是「改了再报错」）',
  );
  assert.throws(() => registry.setGovernance('ghost', { state: 'frozen' }), /资产不存在: ghost/);
});

test('B3 治理变更入链：action=governance 且回写 ledgerSeq，链验签仍绿', () => {
  const { registry, ledger } = build(true);
  ledger!.snapshotBefore([]);
  registry.put(recordOf('a'));

  const updated = registry.setGovernance('a', { trustTier: 'evolved', state: 'frozen' });
  assert.strictEqual(updated.governance.trustTier, 'evolved');
  assert.strictEqual(updated.governance.state, 'frozen');
  assert.strictEqual(updated.governance.ledgerSeq, 2, '快照在 seq=1 ⇒ 治理条目落在 seq=2');
  assert.strictEqual(registry.recordOf('a')?.governance.ledgerSeq, 2, '回写后的记录可读回');

  const entries = ledger!.list();
  const governance = entries.filter((e) => e.action === 'governance');
  assert.strictEqual(governance.length, 1, '治理事件不隐身：链上恰好一条');
  assert.strictEqual(governance[0]?.promoted?.name, 'a');
  assert.strictEqual(governance[0]?.promoted?.source, 'governance:evolved/os-sandbox/frozen');
  assert.strictEqual(ledger!.verify().ok, true, '治理条目不得破坏链完整性');

  // 回归：不传 action 的既有调用仍是 promote（Wave A 口径逐字不变）。
  const seq = ledger!.append({ name: 'b', source: 'twist:a+b' });
  const appended = ledger!.list().find((e) => e.seq === seq);
  assert.strictEqual(appended?.action, 'promote', '缺省动作必须仍是 promote');
});

test('B3 档位只可收紧：信任档/隔离档朝更严放行、朝更松即抛（不静默忽略）', () => {
  const { registry } = build(true);
  registry.put(recordOf('a'));

  // 信任档：core → signed → evolved → external 是「更严」方向。
  assert.strictEqual(
    registry.setGovernance('a', { trustTier: 'signed' }).governance.trustTier,
    'signed',
  );
  assert.strictEqual(
    registry.setGovernance('a', { trustTier: 'evolved' }).governance.trustTier,
    'evolved',
  );
  assert.throws(
    () => registry.setGovernance('a', { trustTier: 'core' }),
    /信任档只可收紧不可放宽：evolved → core/,
  );
  assert.strictEqual(
    registry.recordOf('a')?.governance.trustTier,
    'evolved',
    '被拒的放宽不得改状态',
  );

  // 隔离档：os-sandbox 已是最严（下标 3）⇒ 任何其它档都是放宽。
  assert.throws(
    () => registry.setGovernance('a', { isolation: 'wasm' }),
    /隔离档只可收紧不可放宽：os-sandbox → wasm/,
  );

  // 另一条链：从 in-process 起可以收紧到 wasm（但不可回头）。
  const second = new CapabilitySchemaRegistry();
  second.register(new SkillSchema());
  const ledger = new HashChainPromotionLedger({ now: () => '2026-10-04T00:00:00.000Z' });
  const tight = new CapabilityRegistry({ schemas: second, ledger });
  tight.put({
    ...recordOf('b'),
    governance: {
      trustTier: 'core',
      isolation: 'in-process',
      state: 'active',
      ledgerSeq: undefined,
    },
  });
  assert.strictEqual(tight.setGovernance('b', { isolation: 'wasm' }).governance.isolation, 'wasm');
  assert.throws(
    () => tight.setGovernance('b', { isolation: 'vm' }),
    /隔离档只可收紧不可放宽：wasm → vm/,
  );
});

test('B3 状态转移不受档位约束（active→frozen→revoked，且每次都入链）', () => {
  const { registry, ledger } = build(true);
  registry.put(recordOf('a'));
  assert.strictEqual(registry.setGovernance('a', { state: 'frozen' }).governance.state, 'frozen');
  assert.strictEqual(registry.setGovernance('a', { state: 'revoked' }).governance.state, 'revoked');
  assert.strictEqual(
    ledger!.list().filter((e) => e.action === 'governance').length,
    2,
    '两次状态变更 = 两条治理条目',
  );
  assert.strictEqual(ledger!.verify().ok, true);
});
