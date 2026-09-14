import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, withWorktree } from '../../src/subagent/worktreeOps.js';

/** 探测 git 是否可用。 */
function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 建一个临时「仓库」目录（可选择性 git init 并打一个空提交）。 */
function makeRepo(initGit: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'omni-wt-'));
  writeFileSync(join(root, 'seed.txt'), 'omni');
  if (initGit) {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@omni.local'], {
      cwd: root,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'omni-test'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  }
  return root;
}

test(
  'createWorktree 在 git 仓库中创建真实 worktree 并可清理',
  { skip: !gitAvailable() },
  async () => {
    const repo = makeRepo(true);
    try {
      const wt = await createWorktree(repo, 'alpha');
      assert.strictEqual(wt.isolated, 'worktree');
      assert.ok(existsSync(wt.path), 'worktree 路径应存在');
      await wt.cleanup();
      assert.ok(!existsSync(wt.path), 'cleanup 后应移除 worktree');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
);

test('createWorktree 在 git 不可用时降级为目录拷贝并可清理', { skip: gitAvailable() }, async () => {
  const repo = makeRepo(false);
  try {
    const wt = await createWorktree(repo, 'beta');
    assert.strictEqual(wt.isolated, 'copy');
    assert.ok(existsSync(wt.path), '拷贝隔离路径应存在');
    await wt.cleanup();
    assert.ok(!existsSync(wt.path), 'cleanup 后应删除拷贝目录');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('withWorktree 在 fn 抛错时仍执行 cleanup（finally）', async () => {
  const repo = makeRepo(gitAvailable());
  try {
    let observedPath = '';
    await assert.rejects(
      withWorktree(repo, 'gamma', async (path) => {
        observedPath = path;
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.ok(observedPath.length > 0);
    assert.ok(!existsSync(observedPath), '异常路径仍应被清理');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('withWorktree 正常返回 fn 结果', async () => {
  const repo = makeRepo(gitAvailable());
  try {
    const result = await withWorktree(repo, 'delta', async (path) => {
      writeFileSync(join(path, 'child.txt'), 'x');
      return existsSync(join(path, 'child.txt'));
    });
    assert.strictEqual(result, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
