/**
 * A5 回滚原语：声明写集快照/恢复（2026-10-29）。
 *
 * 只覆盖 `WorkflowStep.writes` 的普通文件；目录/通配符跳过。回滚是 best-effort，
 * 不替代 worktree 级隔离。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowWriteSnapshot } from '../../src/autonomy/workflowWriteSnapshot.ts';

test('capture/restore：恢复旧内容、删除新建文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-snap-'));
  try {
    writeFileSync(join(root, 'a.txt'), 'old', 'utf8');
    const snapshot = WorkflowWriteSnapshot.capture(root, ['a.txt', 'b.txt']);
    assert.strictEqual(snapshot.size, 2);

    writeFileSync(join(root, 'a.txt'), 'new', 'utf8');
    writeFileSync(join(root, 'b.txt'), 'created', 'utf8');
    const changed = snapshot.restore();

    assert.strictEqual(changed, 2);
    assert.strictEqual(readFileSync(join(root, 'a.txt'), 'utf8'), 'old');
    assert.strictEqual(existsSync(join(root, 'b.txt')), false, '原本不存在的文件应被删除');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture：越界路径（../）与目录被跳过', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-snap-'));
  try {
    const snapshot = WorkflowWriteSnapshot.capture(root, ['../escape.txt', '.']);
    assert.strictEqual(snapshot.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
