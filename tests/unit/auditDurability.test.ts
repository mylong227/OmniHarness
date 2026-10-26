/**
 * 审计链耐久性：`durable:true` + `close()` 仍保持链完整、内容可见。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditSink } from '../../src/server/services/auditSink.ts';

test('durable 审计：record → close 后内容与链校验仍通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-audit-durable-'));
  try {
    const sink = new AuditSink({ dir, durable: true });
    assert.strictEqual(sink.record({ type: 'test', detail: { a: 1 } }), 1);
    assert.strictEqual(sink.record({ type: 'test', detail: { a: 2 } }), 2);
    sink.close();
    const text = readFileSync(join(dir, 'audit.log'), 'utf8');
    assert.match(text, /"seq":1/);
    assert.match(text, /"seq":2/);
    const verify = new AuditSink({ dir }).verify();
    assert.strictEqual(verify.ok, true);
    assert.strictEqual(verify.count, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
