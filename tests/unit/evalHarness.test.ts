import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scoreTask, runEvalSuite, SMOKE_SUITE } from '../../src/eval/index.js';

// ---- 纯函数评分单测（不依赖 Agent，快速、确定） ----

test('scoreTask: 全部期望满足 → 通过', () => {
  const ws = mkdtempSync(join(tmpdir(), 'eval-score-'));
  try {
    writeFileSync(join(ws, 'out.txt'), 'PROCESSED-OK', 'utf8');
    const { passed, reasons } = scoreTask({
      toolCalls: ['read_file', 'shell', 'write_file'],
      finalText: '结果已写出 PROCESSED-OK',
      expectation: {
        tools: ['read_file', 'shell', 'write_file'],
        text: 'PROCESSED-OK',
        files: { 'out.txt': 'PROCESSED-OK' },
      },
      steps: 4,
      workspaceRoot: ws,
    });
    assert.strictEqual(passed, true);
    assert.strictEqual(reasons.length, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('scoreTask: 缺少期望工具 → 失败并记 reason', () => {
  const ws = mkdtempSync(join(tmpdir(), 'eval-score-'));
  try {
    const { passed, reasons } = scoreTask({
      toolCalls: ['read_file'],
      finalText: 'done',
      expectation: { tools: ['read_file', 'shell'] },
      steps: 2,
      workspaceRoot: ws,
    });
    assert.strictEqual(passed, false);
    assert.ok(reasons.some((r) => r.includes('shell')));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('scoreTask: 终态文本缺失 → 失败', () => {
  const ws = mkdtempSync(join(tmpdir(), 'eval-score-'));
  try {
    const { passed, reasons } = scoreTask({
      toolCalls: [],
      finalText: 'hello',
      expectation: { text: 'world' },
      steps: 1,
      workspaceRoot: ws,
    });
    assert.strictEqual(passed, false);
    assert.ok(reasons.some((r) => r.includes('world')));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('scoreTask: 期望文件不存在 → 失败', () => {
  const ws = mkdtempSync(join(tmpdir(), 'eval-score-'));
  try {
    const { passed, reasons } = scoreTask({
      toolCalls: [],
      finalText: 'done',
      expectation: { files: { 'missing.txt': 'x' } },
      steps: 1,
      workspaceRoot: ws,
    });
    assert.strictEqual(passed, false);
    assert.ok(reasons.some((r) => r.includes('不存在')));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('scoreTask: 步数超上限 → 记 reason 且判失败（fail-closed）', () => {
  const ws = mkdtempSync(join(tmpdir(), 'eval-score-'));
  try {
    const { passed, reasons } = scoreTask({
      toolCalls: [],
      finalText: 'done',
      expectation: { maxSteps: 3 },
      steps: 9,
      workspaceRoot: ws,
    });
    // 步数超额即视为未达预期收敛 → 失败
    assert.strictEqual(passed, false);
    assert.ok(reasons.some((r) => r.includes('步数')));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---- 集成单测：经真实 Agent + ScriptedModel 跑内置 smoke 套件 ----

test('runEvalSuite: 内置 SMOKE_SUITE 全过', async () => {
  const report = await runEvalSuite(SMOKE_SUITE);
  assert.strictEqual(report.total, 2);
  assert.strictEqual(report.failed, 0);
  assert.strictEqual(report.passed, 2);
  // 工具链路任务必须抓到三个工具调用
  const proc = report.results.find((r) => r.id === 'read-process-write');
  assert.ok(proc !== undefined);
  assert.deepStrictEqual([...proc!.toolCalls].sort(), ['read_file', 'shell', 'write_file']);
  // 纯文本任务无工具调用
  const greet = report.results.find((r) => r.id === 'plain-greeting');
  assert.ok(greet !== undefined);
  assert.strictEqual(greet!.toolCalls.length, 0);
});
