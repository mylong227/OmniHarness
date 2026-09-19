import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnDiffTracker } from '../../src/core/turnDiffTracker.js';
import { TurnDiffHooks, TRACKED_WRITE_TOOLS } from '../../src/adapters/diff/turnDiffHooks.js';
import { ToolHookRunner } from '../../src/core/toolHookRunner.js';
import type { ToolHookContext } from '../../src/ports/tool/toolHook.js';
import type { ToolResult } from '../../src/ports/tool/tool.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 构造钩子上下文。 */
function ctx(toolName: string, args: Record<string, unknown>): ToolHookContext {
  return { sessionId: 's1', toolName, target: String(args['path'] ?? ''), args };
}

/** 工具结果。 */
function okResult(): ToolResult {
  return { callId: 'c1', ok: true, output: '' };
}

test('tracker：首次写入基线为 null，产出新建 diff', () => {
  const t = new TurnDiffTracker();
  t.noteWrite('a.txt', null, 'hello\n');
  const diff = t.getUnifiedDiff();
  assert.ok(diff !== undefined);
  assert.match(diff!, /--- a\/a\.txt/);
  assert.match(diff!, /\+\+\+ b\/a\.txt/);
  assert.match(diff!, /\+hello/);
});

test('tracker：同文件二次写入只保留首次基线', () => {
  const t = new TurnDiffTracker();
  t.noteWrite('a.txt', 'old\n', 'mid\n');
  t.noteWrite('a.txt', 'OLD-SHOULD-BE-IGNORED', 'new\n');
  const diff = t.getUnifiedDiff()!;
  assert.match(diff, /-old/);
  assert.match(diff, /\+new/);
  assert.doesNotMatch(diff, /OLD-SHOULD-BE-IGNORED/);
});

test('tracker：invalidate 后不再产出任何 diff', () => {
  const t = new TurnDiffTracker();
  t.noteWrite('a.txt', 'old', 'new');
  t.invalidate();
  assert.strictEqual(t.isValid, false);
  assert.strictEqual(t.getUnifiedDiff(), undefined);
});

test('tracker：reset 后恢复有效且清空', () => {
  const t = new TurnDiffTracker();
  t.noteWrite('a.txt', 'old', 'new');
  t.reset();
  assert.strictEqual(t.isValid, true);
  assert.strictEqual(t.changedCount, 0);
  assert.strictEqual(t.getUnifiedDiff(), undefined);
});

test('tracker：无实质差异时不渲染 hunk', () => {
  const t = new TurnDiffTracker();
  t.noteWrite('a.txt', 'same', 'same');
  assert.strictEqual(t.getUnifiedDiff(), undefined);
});

test('钩子：write_file 经 pre/post 产出新建文件 diff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-diff-'));
  try {
    const t = new TurnDiffTracker();
    const runner = new ToolHookRunner();
    runner.add(new TurnDiffHooks(t, dir).hooks());
    const c = ctx('write_file', { path: 'note.md', content: 'title\n' });
    await runner.pre(c);
    await runner.post(c, okResult());
    const diff = t.getUnifiedDiff();
    assert.ok(diff !== undefined);
    assert.match(diff!, /--- a\/note\.md/);
    assert.match(diff!, /\+title/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('钩子：写后磁盘变化反映进 diff（update 场景）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-diff-'));
  try {
    const file = join(dir, 'x.txt');
    writeFileSync(file, 'alpha\n');
    const t = new TurnDiffTracker();
    const runner = new ToolHookRunner();
    runner.add(new TurnDiffHooks(t, dir).hooks());
    const c = ctx('write_file', { path: 'x.txt', content: 'beta\ngamma\n' });
    await runner.pre(c);
    await runner.post(c, okResult());
    const diff = t.getUnifiedDiff()!;
    assert.match(diff, /-alpha/);
    assert.match(diff, /\+beta/);
    assert.match(diff, /\+gamma/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('钩子：非写类工具（shell）不参与追踪', async () => {
  const t = new TurnDiffTracker();
  const runner = new ToolHookRunner();
  runner.add(new TurnDiffHooks(t, tmpdir()).hooks());
  const c = ctx('shell', { command: 'echo hi' });
  await runner.pre(c);
  await runner.post(c, okResult());
  assert.strictEqual(t.changedCount, 0);
});

test('钩子：写失败（ok=false）不计入 diff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-diff-'));
  try {
    const t = new TurnDiffTracker();
    const runner = new ToolHookRunner();
    runner.add(new TurnDiffHooks(t, dir).hooks());
    const c = ctx('write_file', { path: 'fail.md', content: 'x' });
    await runner.pre(c);
    await runner.post(c, { callId: 'c1', ok: false, error: 'boom' });
    assert.strictEqual(t.changedCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TRACKED_WRITE_TOOLS 仅含显式带 path 的写类工具', () => {
  assert.deepStrictEqual([...TRACKED_WRITE_TOOLS], ['write_file', 'edit', 'apply_patch']);
});
