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
  t.noteWrite('a.txt', 'hello\n');
  const diff = t.getUnifiedDiff();
  assert.ok(diff !== undefined);
  assert.match(diff!, /--- a\/a\.txt/);
  assert.match(diff!, /\+\+\+ b\/a\.txt/);
  assert.match(diff!, /\+hello/);
});

test('tracker：同文件二次写入只保留首次基线', () => {
  const t = new TurnDiffTracker();
  t.recordBaseline('a.txt', 'old\n');
  t.noteWrite('a.txt', 'mid\n');
  t.recordBaseline('a.txt', 'OLD-SHOULD-BE-IGNORED');
  t.noteWrite('a.txt', 'new\n');
  const diff = t.getUnifiedDiff()!;
  assert.match(diff, /-old/);
  assert.match(diff, /\+new/);
  assert.doesNotMatch(diff, /OLD-SHOULD-BE-IGNORED/);
});

test('tracker：invalidate 后 noteWrite 不再污染 changedCount（2026-10-03 修）', () => {
  // 旧实现失效后仍写 current ⇒ changedCount 从 0 变非 0，turn-end 完成闸门据此
  // 误判「本回合改过文件」而平白跑一次验证。
  const t = new TurnDiffTracker();
  t.recordBaseline('a.txt', 'x\n');
  t.noteWrite('a.txt', 'y\n');
  t.invalidate();
  t.noteWrite('b.txt', 'z\n');
  assert.strictEqual(t.changedCount, 0);
  assert.strictEqual(t.getUnifiedDiff(), undefined);
});

test('tracker：reset 后恢复追踪能力', () => {
  const t = new TurnDiffTracker();
  t.recordBaseline('a.txt', 'x\n');
  t.noteWrite('a.txt', 'y\n');
  t.invalidate();
  t.reset();
  t.noteWrite('c.txt', 'new\n');
  assert.strictEqual(t.changedCount, 1);
  assert.ok(t.getUnifiedDiff() !== undefined);
});

test('tracker：invalidate 后不再产出任何 diff', () => {
  const t = new TurnDiffTracker();
  t.recordBaseline('a.txt', 'old');
  t.noteWrite('a.txt', 'new');
  t.invalidate();
  assert.strictEqual(t.isValid, false);
  assert.strictEqual(t.getUnifiedDiff(), undefined);
});

test('tracker：reset 后恢复有效且清空', () => {
  const t = new TurnDiffTracker();
  t.recordBaseline('a.txt', 'old');
  t.noteWrite('a.txt', 'new');
  t.reset();
  assert.strictEqual(t.isValid, true);
  assert.strictEqual(t.changedCount, 0);
  assert.strictEqual(t.getUnifiedDiff(), undefined);
});

test('tracker：无实质差异时不渲染 hunk', () => {
  const t = new TurnDiffTracker();
  t.recordBaseline('a.txt', 'same');
  t.noteWrite('a.txt', 'same');
  assert.strictEqual(t.getUnifiedDiff(), undefined);
});

test('tracker：hasBaseline 区分「已登记 null（新建）」与「未登记」（供钩子决定是否读盘）', () => {
  const t = new TurnDiffTracker();
  assert.strictEqual(t.hasBaseline('a.txt'), false);
  t.recordBaseline('a.txt', null);
  assert.strictEqual(t.hasBaseline('a.txt'), true, '登记 null 也必须算已登记');
  t.reset();
  assert.strictEqual(t.hasBaseline('a.txt'), false, 'reset 必须连同基线一起清空');
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

test('钩子：回合边界后基线重置，diff 不跨回合累计（PROJECT_BOARD §3-2 回归判据）', async () => {
  // 旧实现：钩子自持 baseline Map，而 `TurnRunner` 回合末只调 `tracker.reset()` ⇒ 那张表
  // 从不清理。回合 2 写同一文件时 before 侧仍是「回合 1 之前」的内容，`turn_diff` 事件
  // 呈现跨回合累计差异（用户看到自己没做过的改动）。
  const dir = mkdtempSync(join(tmpdir(), 'oh-diff-turn-'));
  try {
    const file = join(dir, 'x.txt');
    writeFileSync(file, 'v0\n');
    const t = new TurnDiffTracker();
    const runner = new ToolHookRunner();
    runner.add(new TurnDiffHooks(t, dir).hooks());

    // 回合 1：v0 → v1
    const c1 = ctx('write_file', { path: 'x.txt', content: 'v1\n' });
    await runner.pre(c1);
    await runner.post(c1, okResult());
    assert.match(t.getUnifiedDiff()!, /-v0/);

    // 回合边界：TurnRunner 回合末的动作（产事件 + reset）
    t.reset();

    // 回合 2：v1 → v2。before 侧必须是 v1（回合 2 起点），绝不能退回 v0。
    writeFileSync(file, 'v1\n');
    const c2 = ctx('write_file', { path: 'x.txt', content: 'v2\n' });
    await runner.pre(c2);
    await runner.post(c2, okResult());
    const diff = t.getUnifiedDiff()!;
    assert.match(diff, /-v1/, '回合 2 的 before 必须是回合 1 结束时的内容');
    assert.match(diff, /\+v2/);
    assert.doesNotMatch(diff, /v0/, '回合 2 的 diff 不得包含回合 1 之前的基线（跨回合累计）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
