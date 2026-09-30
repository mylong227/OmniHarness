/**
 * FileDecisionTraceAdapter 单测：验证 append-only JSONL 落盘（按日分文件、逐行追加、格式合法）。
 *
 * 覆盖：首次写入创建文件、二次写入追加（不覆盖）、每行是一条合法 JSON 且字段完整、fail-open 不抛错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileDecisionTraceAdapter } from '../../src/adapters/decision/fileDecisionTraceAdapter.js';
import type { DecisionTrace } from '../../src/ports/decision/decisionTrace.js';

/** 创建一个独立临时工作区根（避免并发测试互相污染分片文件）。 */
const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'omni-trace-'));

/** 读取当日 trace 文件全部行（JSON 解析）。 */
const readLines = (root: string): DecisionTrace[] => {
  const dir = join(root, '.omniharness/decision-traces');
  const file = `${new Date().toISOString().slice(0, 10)}.jsonl`;
  const path = join(dir, file);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as DecisionTrace);
};

test('首次 record → 创建分片文件并写入一条合法 JSON', () => {
  const root = makeRoot();
  try {
    const adapter = new FileDecisionTraceAdapter(root);
    adapter.record({
      sessionId: 's1',
      toolName: 'write_file',
      mode: 'enforce',
      noul: 0.9,
      available: true,
      testRan: true,
      testPassed: true,
      testExitCode: 0,
      at: 1_700_000_000_000,
    });
    const lines = readLines(root);
    assert.strictEqual(lines.length, 1, '应写入一条');
    assert.strictEqual(lines[0]?.sessionId, 's1');
    assert.strictEqual(lines[0]?.noul, 0.9);
    assert.strictEqual(lines[0]?.mode, 'enforce');
    assert.strictEqual(lines[0]?.testPassed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('二次 record → 追加而非覆盖（append-only）', () => {
  const root = makeRoot();
  try {
    const adapter = new FileDecisionTraceAdapter(root);
    adapter.record({
      sessionId: 's1',
      toolName: 'write_file',
      mode: 'shadow',
      noul: 0.4,
      available: true,
      testRan: true,
      testPassed: false,
      testExitCode: 1,
      at: 1,
    });
    adapter.record({
      sessionId: 's2',
      toolName: 'edit_file',
      mode: 'shadow',
      noul: undefined,
      available: false,
      testRan: false,
      testPassed: undefined,
      testExitCode: undefined,
      at: 2,
    });
    const lines = readLines(root);
    assert.strictEqual(lines.length, 2, '两样本应各占一行');
    assert.strictEqual(lines[1]?.sessionId, 's2');
    assert.strictEqual(lines[1]?.noul, undefined);
    assert.strictEqual(lines[1]?.available, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('record 失败静默（dir 不可用也不抛错）', () => {
  // 传入一个不可能创建的目录（Windows 保留名），验证 fail-open：不抛错。
  const adapter = new FileDecisionTraceAdapter('\\\\.\\NUL\\cannot\\write');
  assert.doesNotThrow(() => {
    adapter.record({
      sessionId: 's1',
      toolName: 'x',
      mode: 'enforce',
      noul: 0.5,
      available: true,
      testRan: false,
      testPassed: undefined,
      testExitCode: undefined,
      at: 1,
    });
  });
});
