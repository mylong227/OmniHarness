// (P3, I-P3-4) 禁闭色荷端口：多维色荷张量收缩得单态才可暴露；裸能力结构性拒配。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfinementEngine } from '../../src/adapters/monitoring/confinementEngine.js';

const singlet = { color: 0, flavor: 0, permission: 0, expiry: 0 };

test('① 单态能力可暴露；裸能力（非单态）结构性拒配', () => {
  const c = new ConfinementEngine();
  const bare = { id: 'bare', charge: { color: 1, flavor: 0, permission: 0, expiry: 0 } };
  assert.strictEqual(c.isSinglet({ id: 's', charge: singlet }), true, '全 0 是单态');
  assert.strictEqual(c.isSinglet(bare), false, 'color=1 非单态');
  assert.strictEqual(c.expose({ id: 's', charge: singlet }).exposed, true, '单态可暴露');
  const v = c.expose(bare);
  assert.strictEqual(v.exposed, false, '裸能力拒配');
  assert.match(v.reason, /confined/);
});

test('② 两能力色荷张量收缩得单态 → 束缚能力可暴露；否则 fail-closed 拒绝', () => {
  const c = new ConfinementEngine();
  // 互补：红(1)+其反色(2)=3≡0 mod 3。
  const red = { id: 'red', charge: { color: 1, flavor: 0, permission: 0, expiry: 0 } };
  const antiRed = { id: 'anti', charge: { color: 2, flavor: 0, permission: 0, expiry: 0 } };
  const bound = c.bind(red, antiRed);
  assert.ok(bound !== undefined, '互补组合得单态 → 允许束缚');
  assert.deepStrictEqual(bound!.charge, singlet, '束缚态色荷必为单态');
  assert.strictEqual(c.expose(bound!).exposed, true, '束缚态可暴露');

  // 非互补：两红(1)+(1)=2≠0 mod 3 → 拒绝。
  const red2 = { id: 'red2', charge: { color: 1, flavor: 0, permission: 0, expiry: 0 } };
  assert.strictEqual(c.bind(red, red2), undefined, '非互补组合 fail-closed 拒绝');
});

test('③ 多维权衡：四维(色×味×权限×时效)须同时互补才得单态', () => {
  const c = new ConfinementEngine();
  const a = { id: 'a', charge: { color: 1, flavor: 2, permission: 1, expiry: 2 } };
  const b = { id: 'b', charge: { color: 2, flavor: 1, permission: 2, expiry: 1 } };
  const bound = c.bind(a, b);
  assert.ok(bound !== undefined, '四维同时互补 → 单态');
  assert.deepStrictEqual(bound!.charge, singlet);
  // 仅色互补、味不互补 → 非单态。
  const c2 = { id: 'c', charge: { color: 2, flavor: 0, permission: 0, expiry: 0 } };
  assert.strictEqual(c.bind(a, c2), undefined, '味不互补 → 拒绝（复合约束）');
});
