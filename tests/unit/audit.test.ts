import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditSink } from '../../src/server/services/auditSink.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'audit-'));
}

test('record 写入合法 JSONL 且含 type/sessionId', () => {
  const dir = tmp();
  try {
    const sink = new AuditSink({ dir });
    sink.record({
      ts: new Date().toISOString(),
      type: 'tool_call',
      sessionId: 's1',
      actor: 'u',
      detail: { x: 1 },
    });
    sink.record({ ts: new Date().toISOString(), type: 'login', sessionId: 's1' });

    const file = join(dir, 'audit.log');
    assert.ok(existsSync(file), 'audit.log 应被创建');
    const text = readFileSync(file, 'utf8').trim();
    const lines = text.split('\n');
    assert.strictEqual(lines.length, 2);
    const first = JSON.parse(lines[0] as string);
    assert.strictEqual(first.type, 'tool_call');
    assert.strictEqual(first.sessionId, 's1');
    assert.deepStrictEqual(first.detail, { x: 1 });
    const second = JSON.parse(lines[1] as string);
    assert.strictEqual(second.type, 'login');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('指定 path 时写入该文件', () => {
  const dir = tmp();
  try {
    const p = join(dir, 'sub', 'custom.log');
    const sink = new AuditSink({ path: p });
    sink.record({ ts: new Date().toISOString(), type: 'a', sessionId: 's9' });
    assert.ok(existsSync(p), '嵌套目录应被创建');
    const parsed = JSON.parse(readFileSync(p, 'utf8').trim());
    assert.strictEqual(parsed.sessionId, 's9');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未配置 dir/path 时 no-op 不创建文件', () => {
  const dir = tmp();
  try {
    const sink = new AuditSink();
    sink.record({ ts: new Date().toISOString(), type: 'x', sessionId: 's' });
    assert.strictEqual(existsSync(join(dir, 'audit.log')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('close 写链头 sidecar，重启续链；文件大小不匹配时回落全量', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'audit.log');
    const first = new AuditSink({ path });
    first.record({ ts: new Date().toISOString(), type: 'a', sessionId: 's' });
    first.close();
    assert.ok(existsSync(`${path}.head.json`), 'close 后应写 head sidecar');
    const head = JSON.parse(readFileSync(`${path}.head.json`, 'utf8')) as { seq: number };
    assert.strictEqual(head.seq, 1);

    const second = new AuditSink({ path });
    assert.strictEqual(
      second.record({ ts: new Date().toISOString(), type: 'b', sessionId: 's' }),
      2,
      'sidecar 命中应续到 seq 2',
    );
    second.close();

    // 模拟崩溃后多出一行（sidecar 的 size 不再匹配）⇒ 必须全量重读，不能错续。
    appendFileSync(path, '\n', 'utf8');
    const third = new AuditSink({ path });
    assert.strictEqual(
      third.record({ ts: new Date().toISOString(), type: 'c', sessionId: 's' }),
      3,
    );
    assert.strictEqual(third.verify().ok, true);
    third.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
