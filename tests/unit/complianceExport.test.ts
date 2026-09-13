import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildComplianceReport,
  formatCompliance,
} from '../../src/server/services/auditExporter.js';
import type { AuditEvent } from '../../src/server/services/auditSink.js';

const sample: AuditEvent[] = [
  {
    ts: '2026-01-01T00:00:00.000Z',
    type: 'tool_call',
    sessionId: 's1',
    actor: 'user',
    detail: { tool: 'fs.read' },
  },
  { ts: '2026-01-02T00:00:00.000Z', type: 'approval', sessionId: 's1', actor: 'user' },
  {
    ts: '2026-01-03T00:00:00.000Z',
    type: 'tool_call',
    sessionId: 's2',
    actor: 'system',
    detail: { tool: 'shell' },
  },
  { ts: '2026-01-04T00:00:00.000Z', type: 'error', sessionId: 's2', actor: 'system' },
];

test('buildComplianceReport：摘要计数 + 按类型分布 + 完整性哈希', () => {
  const report = buildComplianceReport(sample, { type: 'tool_call' });
  assert.strictEqual(report.schema, 'omniharness.audit.compliance/v1');
  assert.strictEqual(report.summary.total, 2);
  assert.strictEqual(report.summary.byType['tool_call'], 2);
  assert.strictEqual(report.events.length, 2);
  assert.strictEqual(report.summary.integrityHash.length, 64);
});

test('buildComplianceReport：时间窗过滤 + actors + 首末事件时间', () => {
  const report = buildComplianceReport(sample, { since: '2026-01-03T00:00:00.000Z' });
  assert.strictEqual(report.summary.total, 2);
  assert.deepStrictEqual(report.summary.actors.slice().sort(), ['system']);
  assert.strictEqual(report.summary.firstEvent, '2026-01-03T00:00:00.000Z');
  assert.strictEqual(report.summary.lastEvent, '2026-01-04T00:00:00.000Z');
});

test('formatCompliance：合法 JSON 含 summary', () => {
  const json = formatCompliance(buildComplianceReport(sample, {}));
  const parsed = JSON.parse(json) as { schema: string; summary: { total: number } };
  assert.strictEqual(parsed.schema, 'omniharness.audit.compliance/v1');
  assert.strictEqual(parsed.summary.total, 4);
});

test('CLI：audit export --compliance 输出合规报告 JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comp-'));
  const file = join(dir, 'audit.log');
  const cli = join(process.cwd(), 'dist/src/cli/exec.js');
  try {
    const lines = sample.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(file, lines, 'utf8');
    const out = execFileSync(
      process.execPath,
      [cli, 'audit', 'export', '--audit-file', file, '--compliance'],
      {
        encoding: 'utf8',
      },
    );
    const parsed = JSON.parse(out) as {
      schema: string;
      summary: { total: number; integrityHash: string };
    };
    assert.strictEqual(parsed.schema, 'omniharness.audit.compliance/v1');
    assert.strictEqual(parsed.summary.total, 4);
    assert.strictEqual(parsed.summary.integrityHash.length, 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
