import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SafeFs } from '../../src/server/services/safeFs.js';
import { AuditSink } from '../../src/server/services/auditSink.js';

test('SafeFs.safeReadFile 整文件读：返回完整内容与真实大小', () => {
  const dir = mkdtempSync(join(tmpdir(), 'safeFs-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const result = SafeFs.safeReadFile(dir, 'a.txt');
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.buffer.toString('utf8'), 'hello');
      assert.strictEqual(result.size, 5);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SafeFs.safeReadFile 有界读：maxBytes 截断 Buffer 但 size 仍报真实大小', () => {
  const dir = mkdtempSync(join(tmpdir(), 'safeFs-'));
  try {
    writeFileSync(join(dir, 'b.txt'), 'x'.repeat(100));
    const result = SafeFs.safeReadFile(dir, 'b.txt', 10);
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.buffer.length, 10);
      assert.strictEqual(result.size, 100);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SafeFs.safeReadFile 体积上限 fail-closed：超 64 MiB 拒绝整文件读入内存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'safeFs-'));
  try {
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(65 * 1024 * 1024));
    const result = SafeFs.safeReadFile(dir, 'big.bin');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /过大/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SafeFs.safeReadFile 路径穿越 fail-closed：越界路径拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'safeFs-'));
  try {
    const result = SafeFs.safeReadFile(dir, '../escape.txt');
    assert.strictEqual(result.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AuditSink.read 往返事件且 verify 链完整（readCapped 正常路径）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const sink = new AuditSink({ dir });
    sink.record({ type: 'x' });
    sink.record({ type: 'y' });
    const events = sink.read();
    assert.strictEqual(events.length, 2);
    const report = sink.verify();
    assert.strictEqual(report.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
