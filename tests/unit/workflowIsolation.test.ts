/**
 * A5 worktree 隔离：成功才把改动应用回主工作区，失败丢弃（2026-10-29）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowIsolation } from '../../src/autonomy/workflowIsolation.ts';

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'wf-iso-repo-'));
  execFileSync('git', ['-C', root, 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'], {
    stdio: 'ignore',
  });
  execFileSync('git', ['-C', root, 'config', 'user.name', 'test'], { stdio: 'ignore' });
  writeFileSync(join(root, 'a.txt'), 'old', 'utf8');
  execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'commit', '-m', 'init'], { stdio: 'ignore' });
  return root;
}

test('commit：隔离区改动（含新文件）应用回主工作区', () => {
  const root = initRepo();
  const isolation = WorkflowIsolation.create(root);
  try {
    writeFileSync(join(isolation.root, 'a.txt'), 'new', 'utf8');
    writeFileSync(join(isolation.root, 'b.txt'), 'created', 'utf8');
    assert.ok(isolation.commit() > 0);
    assert.strictEqual(readFileSync(join(root, 'a.txt'), 'utf8'), 'new');
    assert.strictEqual(readFileSync(join(root, 'b.txt'), 'utf8'), 'created');
  } finally {
    isolation.discard();
    rmSync(root, { recursive: true, force: true });
  }
});

test('discard：隔离区改动不落到主工作区', () => {
  const root = initRepo();
  const isolation = WorkflowIsolation.create(root);
  try {
    writeFileSync(join(isolation.root, 'c.txt'), 'nope', 'utf8');
    isolation.discard();
    assert.strictEqual(existsSync(join(root, 'c.txt')), false);
  } finally {
    isolation.discard();
    rmSync(root, { recursive: true, force: true });
  }
});
