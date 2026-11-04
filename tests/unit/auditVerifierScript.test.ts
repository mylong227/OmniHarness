/**
 * HTML 内嵌复核器（浏览器脚本）的判据。
 *
 * 做法：把 `AUDIT_VERIFIER_SCRIPT` 放进 `node:vm`，用一个最小 DOM 替身跑一遍，
 * 断言：① 干净报告 ⇒ 状态为「链完整」；② 改动任一记录 ⇒ 状态为「不可信」。
 * 这保证"报告打开后自己就能验"不是一句宣传——脚本与 Node 侧算法真的算出同一个链头。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { AUDIT_VERIFIER_SCRIPT } from '../../src/apps/audit/auditVerifierScript.ts';
import { AuditReportBuilder } from '../../src/apps/audit/auditReportBuilder.ts';
import { AuditSourceLoader } from '../../src/apps/audit/auditSourceLoader.ts';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'audit');

/** 报告夹具。 */
function reportJson(): string {
  const loaded = new AuditSourceLoader().load(join(FIXTURES, 'omni.jsonl'));
  const report = new AuditReportBuilder().build(loaded, {
    generatorVersion: 'test',
    generatedAt: '2026-11-02T00:00:00.000Z',
  });
  return JSON.stringify(report);
}

/**
 * 在最小 DOM 替身里执行内嵌脚本。
 * @param payload 载荷 JSON。
 * @returns 结果文本与状态徽章文本。
 */
function runVerifier(payload: string): { readonly result: string; readonly badge: string } {
  const elements: Record<string, { textContent: string; className: string }> = {
    'oh-audit-payload': { textContent: payload, className: '' },
    'oh-verify-state': { textContent: '', className: '' },
    'oh-verify-result': { textContent: '', className: '' },
  };
  const document = {
    getElementById: (id: string): (typeof elements)[string] | null => elements[id] ?? null,
  };
  const button = { addEventListener: (): void => undefined };
  elements['oh-verify'] = { textContent: '', className: '' };
  const sandbox = {
    document: {
      getElementById: (id: string): unknown =>
        id === 'oh-verify' ? button : document.getElementById(id),
    },
    TextEncoder,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Uint8Array,
    DataView,
    Error,
  };
  vm.runInNewContext(AUDIT_VERIFIER_SCRIPT, sandbox);
  return {
    result: elements['oh-verify-result']?.textContent ?? '',
    badge: elements['oh-verify-state']?.textContent ?? '',
  };
}

test('① 干净报告：浏览器脚本复核通过，并给出链头前 16 位', () => {
  const report = JSON.parse(reportJson()) as { integrity: { head: string }; records: unknown[] };
  const out = runVerifier(reportJson());
  assert.strictEqual(out.badge, '链完整');
  assert.match(out.result, /复核通过/);
  assert.ok(out.result.includes(report.integrity.head.slice(0, 16)));
  assert.match(out.result, new RegExp(`${String(report.records.length)} 条记录`));
});

test('② 改动一条记录：浏览器脚本必须判「不可信」并定位', () => {
  const report = JSON.parse(reportJson()) as {
    records: { record: { text: string } }[];
  };
  const first = report.records[0];
  assert.ok(first !== undefined);
  first.record.text = '被改过';
  const out = runVerifier(JSON.stringify(report));
  assert.strictEqual(out.badge, '不可信');
  assert.match(out.result, /复核失败/);
});

test('③ 缺载荷 / 坏 JSON：明确失败而不是静默通过', () => {
  assert.strictEqual(runVerifier('not json').badge, '不可信');
  const noRecords = JSON.parse(reportJson()) as Record<string, unknown>;
  delete noRecords['records'];
  const out = runVerifier(JSON.stringify(noRecords));
  assert.strictEqual(out.badge, '不可信');
});

test('④ 脚本不引用任何外部资源（离线可验的硬条件）', () => {
  assert.doesNotMatch(AUDIT_VERIFIER_SCRIPT, /https?:\/\//);
  assert.doesNotMatch(AUDIT_VERIFIER_SCRIPT, /fetch\(|XMLHttpRequest|import\(/);
});

test('⑤ 源码只导出一个常量（没有可执行的顶层副作用）', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'apps', 'audit', 'auditVerifierScript.ts'),
    'utf8',
  );
  const exported = source.match(/^export /gm) ?? [];
  assert.strictEqual(exported.length, 1);
  assert.match(source, /export const AUDIT_VERIFIER_SCRIPT/);
});

test('⑥ 改 summary.total：浏览器脚本必须判「不可信」（2026-11-04 与 CLI verify 同口径）', () => {
  const report = JSON.parse(reportJson()) as { summary: { total: number } };
  report.summary.total += 1;
  const out = runVerifier(JSON.stringify(report));
  assert.strictEqual(out.badge, '不可信');
  assert.match(out.result, /summary/);
});

test('⑦ 改 coverage.recognized：浏览器脚本必须判「不可信」（与 CLI verify 同口径）', () => {
  const report = JSON.parse(reportJson()) as { coverage: { recognized: number } };
  report.coverage.recognized += 1;
  const out = runVerifier(JSON.stringify(report));
  assert.strictEqual(out.badge, '不可信');
  assert.match(out.result, /coverage/);
});
