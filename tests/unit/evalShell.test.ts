import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalHarness } from '../../src/eval/evalHarness.js';

function ws() {
  return mkdtempSync(join(tmpdir(), 'omni-eval-shell-'));
}

test('scoreTask.run: 命令退出码 0 → 通过', () => {
  const root = ws();
  try {
    writeFileSync(join(root, 'ok.mjs'), 'export const x = 1;\n');
    const { passed, reasons } = EvalHarness.scoreTask({
      toolCalls: [],
      finalText: undefined,
      expectation: { run: { cmd: 'node -e "process.exit(0)"' } },
      steps: 1,
      workspaceRoot: root,
    });
    assert.strictEqual(passed, true);
    assert.strictEqual(reasons.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scoreTask.run: 命令非零退出 → 失败', () => {
  const root = ws();
  try {
    const { passed, reasons } = EvalHarness.scoreTask({
      toolCalls: [],
      finalText: undefined,
      expectation: { run: { cmd: 'node -e "process.exit(3)"' } },
      steps: 1,
      workspaceRoot: root,
    });
    assert.strictEqual(passed, false);
    assert.ok(reasons.some((r) => r.includes('验证命令') && r.includes('3')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scoreTask.run: 文件 + 命令组合校验', () => {
  const root = ws();
  try {
    writeFileSync(join(root, 'a.mjs'), 'export function f() { return 1; }\n');
    // 文件存在但命令失败 → 整体失败。
    const fail = EvalHarness.scoreTask({
      toolCalls: [],
      finalText: undefined,
      expectation: {
        files: { 'a.mjs': 'export function f' },
        run: { cmd: 'node -e "process.exit(1)"' },
      },
      steps: 1,
      workspaceRoot: root,
    });
    assert.strictEqual(fail.passed, false);
    // 文件 + 命令都通过 → 通过。
    const ok = EvalHarness.scoreTask({
      toolCalls: [],
      finalText: undefined,
      expectation: {
        files: { 'a.mjs': 'export function f' },
        run: { cmd: 'node -e "process.exit(0)"' },
      },
      steps: 1,
      workspaceRoot: root,
    });
    assert.strictEqual(ok.passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
