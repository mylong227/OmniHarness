import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiffReview } from '../../src/server/services/diffReview.js';
import { RepoPathGuard } from '../../src/server/services/repoPathGuard.js';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = gitAvailable ? false : 'git 不可用，跳过 git 集成用例';

function withRepo<T>(init: boolean, fn: (ws: string, review: DiffReview) => T): T {
  const ws = mkdtempSync(join(tmpdir(), 'diff-review-'));
  try {
    if (init) spawnSync('git', ['init'], { cwd: ws, encoding: 'utf8' });
    const review = new DiffReview({ workspaceRoot: () => ws, guard: new RepoPathGuard(() => ws) });
    return fn(ws, review);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

function porcelain(ws: string, rel: string): string {
  const st = spawnSync('git', ['status', '--porcelain', '--', rel], { cwd: ws, encoding: 'utf8' });
  return st.stdout.trim();
}

test('DiffReview：非 git 工作区 gitRootOrFail 抛错（fail-closed 前置）', { skip }, () => {
  withRepo(false, (_ws, review) => {
    assert.throws(() => review.gitRootOrFail(), /当前工作区不是 git 仓库/);
    assert.throws(() => review.stageFile({ path: 'a.txt' }), /当前工作区不是 git 仓库/);
  });
});

test('DiffReview：入参缺失/非法在触达 git 前即抛错', { skip }, () => {
  withRepo(true, (_ws, review) => {
    assert.throws(() => review.stageFile({}), /changes.stageFile 需要 path/);
    assert.throws(() => review.revertFile({}), /changes.revertFile 需要 path/);
    assert.throws(() => review.stageHunk({ path: 'a.txt' }), /changes.stageHunk 需要 hunk 文本/);
    assert.throws(() => review.stageHunk({ path: 'a.txt', hunk: '   ' }), /需要 hunk 文本/);
    assert.throws(() => review.revertHunk({ hunk: 'x' }), /changes.revertHunk 需要 path/);
  });
});

test('DiffReview：拒绝绝对路径与仓库外路径（复用路径守卫）', { skip }, () => {
  withRepo(true, (_ws, review) => {
    assert.throws(() => review.stageFile({ path: 'C:\\x.txt' }), /仅接受仓库内相对路径/);
    assert.throws(() => review.stageFile({ path: '../x.txt' }), /路径越出仓库范围/);
  });
});

test('DiffReview：stageFile 就地 stage 未跟踪新文件', { skip }, () => {
  withRepo(true, (ws, review) => {
    writeFileSync(join(ws, 'new.txt'), 'hi', 'utf8');
    assert.ok(porcelain(ws, 'new.txt').startsWith('??'), '初始应为未跟踪');
    assert.deepStrictEqual(review.stageFile({ path: 'new.txt' }), { ok: true });
    assert.ok(porcelain(ws, 'new.txt').startsWith('A'), 'stage 后应变为新增（A）');
  });
});

test('DiffReview：revertFile 拒绝丢弃未跟踪文件（防误删）', { skip }, () => {
  withRepo(true, (ws, review) => {
    writeFileSync(join(ws, 'loose.txt'), 'hi', 'utf8');
    assert.throws(() => review.revertFile({ path: 'loose.txt' }), /未跟踪文件不做服务端丢弃/);
  });
});

test('DiffReview：hunk 文本缺 @@ 头时阶段操作抛错', { skip }, () => {
  withRepo(true, (ws, review) => {
    writeFileSync(join(ws, 'a.txt'), 'line\n', 'utf8');
    review.stageFile({ path: 'a.txt' });
    assert.throws(
      () => review.stageHunk({ path: 'a.txt', hunk: 'no-at-header' }),
      /hunk 文本缺少 @@ 头/,
    );
  });
});
