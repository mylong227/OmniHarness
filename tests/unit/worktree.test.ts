import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSyncAsync, execFileAsync } from '../helpers/childProcess.js';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeOps } from '../../src/subagent/worktreeOps.js';

/** 探测 git 是否可用。 */
const gitAvailable = (await spawnSyncAsync('git', ['--version'], { stdio: 'ignore' })).status === 0;

/** 建一个临时「仓库」目录（可选择性 git init 并打一个空提交）。 */
async function makeRepo(initGit: boolean): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'omni-wt-'));
  writeFileSync(join(root, 'seed.txt'), 'omni');
  if (initGit) {
    await execFileAsync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await execFileAsync('git', ['config', 'user.email', 'test@omni.local'], {
      cwd: root,
      stdio: 'ignore',
    });
    await execFileAsync('git', ['config', 'user.name', 'omni-test'], {
      cwd: root,
      stdio: 'ignore',
    });
    await execFileAsync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  }
  return root;
}

test(
  'createWorktree 在 git 仓库中创建真实 worktree 并可清理',
  { skip: !gitAvailable },
  async () => {
    const repo = await makeRepo(true);
    try {
      const wt = await WorktreeOps.createWorktree(repo, 'alpha');
      assert.strictEqual(wt.isolated, 'worktree');
      assert.ok(existsSync(wt.path), 'worktree 路径应存在');
      await wt.cleanup();
      assert.ok(!existsSync(wt.path), 'cleanup 后应移除 worktree');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
);

test('createWorktree 在 git 不可用时降级为目录拷贝并可清理', { skip: gitAvailable }, async () => {
  const repo = await makeRepo(false);
  try {
    const wt = await WorktreeOps.createWorktree(repo, 'beta');
    assert.strictEqual(wt.isolated, 'copy');
    assert.ok(existsSync(wt.path), '拷贝隔离路径应存在');
    await wt.cleanup();
    assert.ok(!existsSync(wt.path), 'cleanup 后应删除拷贝目录');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('withWorktree 在 fn 抛错时仍执行 cleanup（finally）', async () => {
  const repo = await makeRepo(gitAvailable);
  try {
    let observedPath = '';
    await assert.rejects(
      WorktreeOps.withWorktree(repo, 'gamma', async (path) => {
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
  const repo = await makeRepo(gitAvailable);
  try {
    const result = await WorktreeOps.withWorktree(repo, 'delta', async (path) => {
      writeFileSync(join(path, 'child.txt'), 'x');
      return existsSync(join(path, 'child.txt'));
    });
    assert.strictEqual(result, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test(
  '第六轮：清理前可取回 worktree 内的改动（修改 + 新建 + 删除都能 git apply 回主仓）',
  { skip: !gitAvailable },
  async () => {
    // 看板 §8.1 的回归判据：子代理写入落在隔离工作树，而 cleanup 是 `worktree remove --force`
    // + `branch -D` ⇒ 不先采集就是静默丢弃。这里断言"清理前确实能取回可应用回主仓的 patch"。
    const repo = await makeRepo(true);
    try {
      // 基线里预置"将被删除"的文件：patch 才能在主仓干净应用（工作树若另打 commit 会分叉）。
      writeFileSync(join(repo, 'doomed.txt'), 'bye\n');
      await execFileAsync('git', ['add', 'doomed.txt'], { cwd: repo, stdio: 'ignore' });
      await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repo, stdio: 'ignore' });

      const wt = await WorktreeOps.createWorktree(repo, 'capture');
      writeFileSync(join(wt.path, 'seed.txt'), 'omni-changed'); // 修改
      writeFileSync(join(wt.path, 'brand-new.txt'), 'new\n'); // 新建（未跟踪）
      rmSync(join(wt.path, 'doomed.txt')); // 删除

      const changes = await WorktreeOps.collectChanges(wt.path);
      assert.ok(changes.files.includes('seed.txt'), `修改应被采集：${changes.files.join(',')}`);
      assert.ok(changes.files.includes('brand-new.txt'), '未跟踪的新建文件必须进清单');
      assert.ok(changes.files.includes('doomed.txt'), '删除也必须进清单');
      assert.match(changes.patch, /omni-changed/, 'patch 必须含修改内容');
      assert.match(changes.patch, /brand-new\.txt/, 'patch 必须含新建文件');
      assert.strictEqual(changes.truncated, false);

      // 落盘后必须能 `git apply` 回主仓库（这才是"可取回"的定义）。
      const artifact = await WorktreeOps.persistChanges(repo, 'sess-1', changes);
      assert.ok(existsSync(join(repo, artifact.relativePath)), 'patch 工件应落盘');
      await execFileAsync('git', ['apply', artifact.relativePath], { cwd: repo, stdio: 'ignore' });
      // 换行口径：临时仓库在 Windows 上可能有 core.autocrlf ⇒ 归一化后再比（断言的是内容，不是行尾）。
      assert.strictEqual(
        readFileSync(join(repo, 'brand-new.txt'), 'utf8').replace(/\r\n/g, '\n'),
        'new\n',
      );
      assert.strictEqual(
        readFileSync(join(repo, 'seed.txt'), 'utf8').replace(/\r\n/g, '\n'),
        'omni-changed',
      );
      assert.ok(!existsSync(join(repo, 'doomed.txt')), '删除也必须被应用');

      await wt.cleanup();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
);

test('第六轮：无改动时采集为空（不得凭空产出 patch）', { skip: !gitAvailable }, async () => {
  const repo = await makeRepo(true);
  try {
    const wt = await WorktreeOps.createWorktree(repo, 'nochange');
    const changes = await WorktreeOps.collectChanges(wt.path);
    assert.deepStrictEqual(changes.files, []);
    assert.strictEqual(changes.patch, '');
    assert.strictEqual(changes.truncated, false);
    await wt.cleanup();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('第六轮：无改动时采集为空（不得凭空产出 patch）', { skip: !gitAvailable }, async () => {
  const repo = await makeRepo(true);
  try {
    const wt = await WorktreeOps.createWorktree(repo, 'nochange');
    const changes = await WorktreeOps.collectChanges(wt.path);
    assert.deepStrictEqual(changes.files, []);
    assert.strictEqual(changes.patch, '');
    assert.strictEqual(changes.truncated, false);
    await wt.cleanup();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
