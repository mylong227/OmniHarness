// 审计日志哈希链（#79）：合规硬伤修复的回归测试。
// 覆盖：链字段正确性、三类篡改检出（改内容 / 删条目 / 插条目）、跨实例续链、
//       no-op 安全性、合规报告携带链校验结果。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditSink } from '../../src/server/audit.js';
import { buildComplianceReport } from '../../src/server/auditExport.js';

/** 建临时审计文件（每次唯一，避免跨运行互相污染）。 */
function tmpFile(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `omni-audit-chain-${tag}-`));
  return join(dir, 'audit.log');
}

/** 写入 n 条事件并返回 sink。 */
function seed(path: string, n: number): AuditSink {
  const sink = new AuditSink({ path });
  for (let i = 1; i <= n; i += 1) {
    sink.record({ type: `evt${i}`, actor: 'tester', detail: { i } });
  }
  return sink;
}

/** 读出行数组（去掉末尾空行）。 */
function linesOf(path: string): string[] {
  return readFileSync(path, 'utf8').trim().split('\n');
}

test('正常记录的链校验通过', () => {
  const sink = seed(tmpFile('ok'), 5);
  const report = sink.verify();
  assert.strictEqual(report.ok, true, '未被改动的日志应校验通过');
  assert.strictEqual(report.count, 5);
});

test('每条记录带 seq/prev/hash，且 prev 指向上一条 hash', () => {
  const path = tmpFile('fields');
  seed(path, 3);
  const events = new AuditSink({ path }).read();
  assert.strictEqual(events.length, 3);
  let prev = '0'.repeat(64);
  for (const [i, e] of events.entries()) {
    assert.strictEqual(e.seq, i + 1, `第 ${i + 1} 条 seq 应连续`);
    assert.strictEqual(e.prev, prev, `第 ${i + 1} 条 prev 应指向上一条 hash`);
    assert.strictEqual(typeof e.hash, 'string');
    assert.strictEqual((e.hash ?? '').length, 64, 'SHA256 应为 64 位十六进制');
    prev = e.hash ?? '';
  }
});

test('篡改内容可被检出（重算 hash 不匹配）', () => {
  const path = tmpFile('tamper');
  seed(path, 3);
  const lines = linesOf(path);
  const e = JSON.parse(lines[1]!) as Record<string, unknown>;
  e.detail = { i: 999 };
  lines[1] = JSON.stringify(e);
  writeFileSync(path, lines.join('\n') + '\n');

  const report = new AuditSink({ path }).verify();
  assert.strictEqual(report.ok, false, '改动 detail 后 hash 应不匹配');
  assert.strictEqual(report.brokenAt, 2);
  assert.match(report.reason ?? '', /hash 不匹配/);
});

test('删除中间条目可被检出（seq 与位置不符）', () => {
  const path = tmpFile('delete');
  seed(path, 4);
  const lines = linesOf(path);
  lines.splice(1, 1);
  writeFileSync(path, lines.join('\n') + '\n');

  const report = new AuditSink({ path }).verify();
  assert.strictEqual(report.ok, false, '删条目前后 seq 不再连续');
  assert.match(report.reason ?? '', /seq=3 与位置不符/);
});

test('插入条目可被检出', () => {
  const path = tmpFile('insert');
  seed(path, 3);
  const lines = linesOf(path);
  lines.splice(1, 0, lines[1]!);
  writeFileSync(path, lines.join('\n') + '\n');

  const report = new AuditSink({ path }).verify();
  assert.strictEqual(report.ok, false, '插入条目会破坏 seq 连续性');
});

test('新实例从文件末尾续链（跨进程重启不断链）', () => {
  const path = tmpFile('resume');
  seed(path, 3);
  const second = new AuditSink({ path });
  const seq = second.record({ type: 'after-restart', actor: 'tester' });
  assert.strictEqual(seq, 4, '序号应从 4 接续，而非从 1 重来');
  const report = second.verify();
  assert.strictEqual(report.ok, true, '续链后整条链仍应完整');
  assert.strictEqual(report.count, 4);
});

test('空日志与未配置目标均视为完整（no-op 安全）', () => {
  const empty = new AuditSink({ path: tmpFile('empty') });
  assert.deepStrictEqual(empty.verify(), { ok: true, count: 0 });

  const none = new AuditSink();
  assert.strictEqual(none.verify().ok, true);
  assert.strictEqual(none.record({ type: 'x' }), undefined, '未配置目标时 record 应 no-op');
});

test('合规报告携带链校验结果，且旧调用方式不受影响', () => {
  const sink = seed(tmpFile('report'), 2);
  const report = buildComplianceReport(sink.read(), {}, { generatedBy: 'test' }, sink.verify());
  assert.strictEqual(report.summary.chain?.ok, true);
  assert.strictEqual(report.summary.chain?.count, 2);

  const legacy = buildComplianceReport(sink.read(), {});
  assert.strictEqual(legacy.summary.chain, undefined, '不传 chain 时字段应缺席（向后兼容）');
});

test('链断裂时合规报告仍标记为不可信（供 CLI 拒绝流转）', () => {
  const path = tmpFile('broken');
  seed(path, 3);
  const lines = linesOf(path);
  lines.splice(1, 1);
  writeFileSync(path, lines.join('\n') + '\n');

  const sink = new AuditSink({ path });
  const chain = sink.verify();
  assert.strictEqual(chain.ok, false);
  const report = buildComplianceReport(sink.read(), {}, {}, chain);
  assert.strictEqual(
    report.summary.chain?.ok,
    false,
    '断裂状态必须随报告一起交付，不能只给快照哈希',
  );
});
