import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryAudit, formatAudit, exportAudit } from '../../src/server/auditExport.js';
import { AuditSink, type AuditEvent } from '../../src/server/audit.js';

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

test('queryAudit：按类型过滤', () => {
  const out = queryAudit(sample, { type: 'tool_call' });
  assert.strictEqual(out.length, 2);
  assert.ok(out.every((e) => e.type === 'tool_call'));
});

test('queryAudit：按会话 + actor 过滤', () => {
  const out = queryAudit(sample, { session: 's1', actor: 'user' });
  assert.deepStrictEqual(
    out.map((e) => e.type),
    ['tool_call', 'approval'],
  );
});

test('queryAudit：时间窗过滤', () => {
  const out = queryAudit(sample, {
    since: '2026-01-02T00:00:00.000Z',
    until: '2026-01-03T00:00:00.000Z',
  });
  assert.deepStrictEqual(
    out.map((e) => e.ts),
    ['2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z'],
  );
});

test('queryAudit：limit 截尾取最近 N 条', () => {
  const out = queryAudit(sample, { limit: 2 });
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(
    out.map((e) => e.ts),
    ['2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z'],
  );
});

test('formatAudit：json 格式可回解析', () => {
  const out = formatAudit(sample, 'json');
  const parsed = JSON.parse(out) as AuditEvent[];
  assert.strictEqual(parsed.length, sample.length);
  assert.strictEqual(parsed[0]?.type, 'tool_call');
});

test('formatAudit：table 含表头与制表分隔', () => {
  const out = formatAudit(sample.slice(0, 1), 'table');
  assert.match(out, /ts\ttype\tsessionId\tactor/);
  assert.match(out, /tool_call/);
});

test('formatAudit：csv 含表头且坏字符被转义', () => {
  const bad: AuditEvent[] = [{ ts: 't', type: 'x', actor: 'user,admin' }];
  const out = formatAudit(bad, 'csv');
  assert.match(out, /ts,type,sessionId,actor/);
  assert.match(out, /"user,admin"/);
});

test('exportAudit：过滤 + 格式化组合', () => {
  const text = exportAudit(sample, { type: 'tool_call' }, 'json');
  assert.strictEqual((JSON.parse(text) as AuditEvent[]).length, 2);
});

test('AuditSink.read：写回并读落盘日志（坏行跳过）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-read-'));
  const file = join(dir, 'audit.log');
  try {
    const sink = new AuditSink({ path: file });
    sink.record({ type: 'a', sessionId: 's1' });
    sink.record({ type: 'b', sessionId: 's2' });
    // 追加一行坏数据，验证跳过而非中断
    const { appendFileSync } = await import('node:fs');
    appendFileSync(file, '这不是合法 JSON\n');
    const events = sink.read();
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(
      events.map((e) => e.type),
      ['a', 'b'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI：omniharness audit export 按类型过滤并输出 json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-cli-'));
  const file = join(dir, 'audit.log');
  const cli = join(process.cwd(), 'dist/src/cli/exec.js');
  try {
    // 直接写一份 JSONL 审计日志
    const lines = sample.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(file, lines, 'utf8');
    const out = execFileSync(
      process.execPath,
      [cli, 'audit', 'export', '--audit-file', file, '--type', 'tool_call', '--format', 'json'],
      {
        encoding: 'utf8',
      },
    );
    const parsed = JSON.parse(out) as AuditEvent[];
    assert.strictEqual(parsed.length, 2);
    assert.ok(parsed.every((e) => e.type === 'tool_call'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI：audit 子命令无 export 动作时给出用法并返回 2', () => {
  const cli = join(process.cwd(), 'dist/src/cli/exec.js');
  let code = 0;
  try {
    execFileSync(process.execPath, [cli, 'audit'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    code = (error as { status?: number }).status ?? 1;
  }
  assert.strictEqual(code, 2);
});
