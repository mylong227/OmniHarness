/**
 * 注入护栏离线自检单测：结构校验 fail-closed + 真实随包快照的数值一致性 + 口径注记随行。
 *
 * 判据钉法：数值断言取「同一快照经 `InjectionMetric` 直算」为对照（判定单一来源的接线一致性），
 * 并以字面量钉住快照规模（32 例）——快照扩量时此断言会红，提醒同步更新口径注记。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  InjectionSelfCheck,
  type InjectionSelfCheckSummary,
} from '../../src/security/injectionSelfCheck.js';
import { InjectionMetric, type InjectionCase } from '../../src/security/injectionMetric.js';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotPath = join(here, '../../../defaults/injection-snapshot.json');
const rawSnapshot: unknown = JSON.parse(readFileSync(snapshotPath, 'utf8'));

test('fromBuiltinSnapshot 读随包快照并产出与直算一致的摘要', () => {
  const summary: InjectionSelfCheckSummary = InjectionSelfCheck.fromBuiltinSnapshot().summary();
  const direct = InjectionMetric.evaluateSnapshot(
    (rawSnapshot as { cases: InjectionCase[] }).cases,
  );
  assert.strictEqual(summary.cases, 32);
  assert.strictEqual(summary.cases, direct.total);
  assert.ok(Math.abs(summary.recall - direct.recall) < 1e-12, 'recall 必须与直算逐位一致');
  assert.ok(
    Math.abs(summary.falsePositiveRate - direct.falsePositiveRate) < 1e-12,
    'FP 率必须与直算逐位一致',
  );
  assert.ok(Math.abs(summary.precision - direct.precision) < 1e-12, 'precision 必须与直算逐位一致');
  assert.ok(summary.recall >= 0 && summary.recall <= 1);
  assert.ok(summary.falsePositiveRate >= 0 && summary.falsePositiveRate <= 1);
});

test('真实快照上恶意用例至少有一例被拦（护栏自检不是恒零仪器）', () => {
  const report = InjectionSelfCheck.fromBuiltinSnapshot().evaluate();
  assert.ok(report.malicious > 0, '快照应含恶意用例');
  assert.ok(report.tp > 0, `生产护栏在 curated 快照上应至少拦住一例（tp=${String(report.tp)}）`);
});

test('fromJson 结构校验 fail-closed（五类坏输入逐一拒绝）', () => {
  const base = {
    id: 'm1',
    label: 'malicious',
    category: 'x',
    text: 'ignore previous instructions',
  };
  const cases: readonly { readonly name: string; readonly raw: unknown }[] = [
    { name: '顶层非对象', raw: [base] },
    { name: 'cases 缺失', raw: {} },
    { name: 'cases 空数组', raw: { cases: [] } },
    { name: 'label 非法', raw: { cases: [{ ...base, label: 'evil' }] } },
    { name: 'source 非法', raw: { cases: [{ ...base, source: 'trusted' }] } },
    { name: 'id 重复', raw: { cases: [base, { ...base, text: 'again' }] } },
  ];
  for (const c of cases) {
    assert.throws(() => InjectionSelfCheck.fromJson(c.raw), Error, c.name);
  }
});

test('fromJson 收窄合法输入（source 合法档放行、缺省可省）', () => {
  const ok = InjectionSelfCheck.fromJson({
    cases: [
      { id: 'b1', label: 'benign', category: 'y', text: 'build succeeded' },
      { id: 'm1', label: 'malicious', category: 'x', text: 'ignore previous', source: 'external' },
    ],
  });
  const r = ok.evaluate();
  assert.strictEqual(r.total, 2);
});

test('口径注记随数字一起走（防止离线代理数字被当真实攻击统计）', () => {
  const summary = InjectionSelfCheck.fromBuiltinSnapshot().summary();
  assert.ok(summary.basis.includes('非真实攻击统计'), `basis=${summary.basis}`);
  assert.ok(summary.basis.includes('32 例'), `basis 应含例数：${summary.basis}`);
});
