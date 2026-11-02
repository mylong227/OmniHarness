/**
 * 审计报告哈希链判据：建链 / 校验 / 三类篡改（改内容、改前驱、删条目）+ 报告字段核对。
 *
 * 与既有的 `auditChain.test.ts`（服务端审计日志的 HMAC 链）区分：本文件针对
 * `audit report` 的**出证报告链**（无密钥、交给第三方复核）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AuditChain } from '../../src/apps/audit/auditChain.ts';
import { AuditReportVerifier } from '../../src/apps/audit/auditReportVerifier.ts';
import type { AuditRecord, AuditReport } from '../../src/apps/audit/auditTypes.ts';

/** 构造一条最小记录。 */
function record(seq: number, text: string): AuditRecord {
  return { seq, ts: null, kind: 'user', title: '用户消息', text };
}

test('① 建链：首条 prev = 创世哈希，链头 = 末条哈希', () => {
  const chain = new AuditChain();
  const linked = chain.link([record(1, 'a'), record(2, 'b')]);
  assert.strictEqual(linked[0]?.prev, AuditChain.GENESIS);
  assert.strictEqual(linked[1]?.prev, linked[0]?.hash);
  assert.strictEqual(chain.headOf(linked), linked[1]?.hash);
  assert.deepStrictEqual(chain.verify(linked), { ok: true, brokenAt: null, reason: null });
});

test('② 空链：链头为创世哈希，校验通过', () => {
  const chain = new AuditChain();
  assert.strictEqual(chain.headOf([]), AuditChain.GENESIS);
  assert.deepStrictEqual(chain.verify([]), { ok: true, brokenAt: null, reason: null });
});

test('③ 改内容 ⇒ 该条 hash 不匹配，定位到下标', () => {
  const chain = new AuditChain();
  const linked = chain.link([record(1, 'a'), record(2, 'b')]);
  const tampered = [linked[0]!, { ...linked[1]!, record: { ...linked[1]!.record, text: 'b2' } }];
  assert.deepStrictEqual(chain.verify(tampered), { ok: false, brokenAt: 1, reason: 'hash' });
});

test('④ 改前驱 ⇒ 第二处报 prev；首条前驱错报 genesis', () => {
  const chain = new AuditChain();
  const linked = chain.link([record(1, 'a'), record(2, 'b')]);
  const second = { ...linked[1]!, prev: 'f'.repeat(64) };
  assert.deepStrictEqual(chain.verify([linked[0]!, second]), {
    ok: false,
    brokenAt: 1,
    reason: 'prev',
  });
  const first = { ...linked[0]!, prev: 'f'.repeat(64) };
  assert.deepStrictEqual(chain.verify([first, linked[1]!]), {
    ok: false,
    brokenAt: 0,
    reason: 'genesis',
  });
});

test('⑤ 删除中间一条会让后一条的 prev 对不上（删条可检出）', () => {
  const chain = new AuditChain();
  const linked = chain.link([record(1, 'a'), record(2, 'b'), record(3, 'c')]);
  const result = chain.verify([linked[0]!, linked[2]!]);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.brokenAt, 1);
});

test('⑥ 报告复核：schema / algorithm / genesis / count / head 任一不符都失败', () => {
  const chain = new AuditChain();
  const linked = chain.link([record(1, 'a')]);
  const report: AuditReport = {
    schema: 'omniharness.audit.report/v1',
    generatedAt: '2026-11-02T00:00:00.000Z',
    generator: { name: 'omniharness', version: 'test' },
    title: 't',
    source: {
      path: 'x',
      format: 'omni',
      sessionId: null,
      workspace: null,
      model: null,
      startedAt: null,
      endedAt: null,
      sha256: '0'.repeat(64),
    },
    summary: {
      total: 1,
      byKind: { user: 1 },
      toolCalls: 0,
      toolFailures: 0,
      approvals: 0,
      filesChanged: 0,
      firstTs: null,
      lastTs: null,
      durationMs: null,
    },
    tokens: null,
    files: [],
    records: linked,
    integrity: {
      algorithm: 'sha256',
      genesis: AuditChain.GENESIS,
      head: chain.headOf(linked),
      count: 1,
    },
  };
  const verifier = new AuditReportVerifier();
  assert.deepStrictEqual(verifier.verify(report), { ok: true, brokenAt: null, reason: null });
  assert.strictEqual(verifier.verify({ ...report, schema: 'x' as never }).reason, 'schema');
  assert.strictEqual(
    verifier.verify({ ...report, integrity: { ...report.integrity, algorithm: 'md5' as never } })
      .reason,
    'algorithm',
  );
  assert.strictEqual(
    verifier.verify({ ...report, integrity: { ...report.integrity, genesis: 'f'.repeat(64) } })
      .reason,
    'genesis',
  );
  assert.strictEqual(
    verifier.verify({ ...report, integrity: { ...report.integrity, count: 2 } }).reason,
    'count',
  );
  assert.strictEqual(
    verifier.verify({ ...report, integrity: { ...report.integrity, head: 'f'.repeat(64) } }).reason,
    'head',
  );
});
