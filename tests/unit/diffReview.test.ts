import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSyncAsync } from '../helpers/childProcess.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiffReview } from '../../src/server/services/diffReview.js';
import { RepoPathGuard } from '../../src/server/services/repoPathGuard.js';

const gitAvailable =
  (await spawnSyncAsync('git', ['--version'], { encoding: 'utf8' })).status === 0;
const skip = gitAvailable ? false : 'git 不可用，跳过 git 集成用例';

async function withRepo<T>(
  init: boolean,
  fn: (ws: string, review: DiffReview) => T | Promise<T>,
): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'diff-review-'));
  try {
    if (init) await spawnSyncAsync('git', ['init'], { cwd: ws, encoding: 'utf8' });
    const review = new DiffReview({ workspaceRoot: () => ws, guard: new RepoPathGuard(() => ws) });
    return await fn(ws, review);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

async function porcelain(ws: string, rel: string): Promise<string> {
  const st = await spawnSyncAsync('git', ['status', '--porcelain', '--', rel], {
    cwd: ws,
    encoding: 'utf8',
  });
  return st.stdout.toString().trim();
}

test('DiffReview：非 git 工作区 gitRootOrFail 抛错（fail-closed 前置）', { skip }, async () => {
  await withRepo(false, async (_ws, review) => {
    await assert.rejects(review.gitRootOrFail(), /当前工作区不是 git 仓库/);
    await assert.rejects(review.stageFile({ path: 'a.txt' }), /当前工作区不是 git 仓库/);
  });
});

test('DiffReview：入参缺失/非法在触达 git 前即抛错', { skip }, async () => {
  await withRepo(true, async (_ws, review) => {
    await assert.rejects(review.stageFile({}), /changes.stageFile 需要 path/);
    await assert.rejects(review.revertFile({}), /changes.revertFile 需要 path/);
    await assert.rejects(review.stageHunk({ path: 'a.txt' }), /changes.stageHunk 需要 hunk 文本/);
    await assert.rejects(review.stageHunk({ path: 'a.txt', hunk: '   ' }), /需要 hunk 文本/);
    await assert.rejects(review.revertHunk({ hunk: 'x' }), /changes.revertHunk 需要 path/);
  });
});

test('DiffReview：拒绝绝对路径与仓库外路径（复用路径守卫）', { skip }, async () => {
  await withRepo(true, async (_ws, review) => {
    await assert.rejects(review.stageFile({ path: 'C:\\x.txt' }), /仅接受仓库内相对路径/);
    await assert.rejects(review.stageFile({ path: '../x.txt' }), /路径越出仓库范围/);
  });
});

test('DiffReview：stageFile 就地 stage 未跟踪新文件', { skip }, async () => {
  await withRepo(true, async (ws, review) => {
    writeFileSync(join(ws, 'new.txt'), 'hi', 'utf8');
    assert.ok((await porcelain(ws, 'new.txt')).startsWith('??'), '初始应为未跟踪');
    assert.deepStrictEqual(await review.stageFile({ path: 'new.txt' }), { ok: true });
    assert.ok((await porcelain(ws, 'new.txt')).startsWith('A'), 'stage 后应变为新增（A）');
  });
});

test('DiffReview：revertFile 拒绝丢弃未跟踪文件（防误删）', { skip }, async () => {
  await withRepo(true, async (ws, review) => {
    writeFileSync(join(ws, 'loose.txt'), 'hi', 'utf8');
    await assert.rejects(review.revertFile({ path: 'loose.txt' }), /未跟踪文件不做服务端丢弃/);
  });
});

test('DiffReview：hunk 文本缺 @@ 头时阶段操作抛错', { skip }, async () => {
  await withRepo(true, async (ws, review) => {
    writeFileSync(join(ws, 'a.txt'), 'line\n', 'utf8');
    await review.stageFile({ path: 'a.txt' });
    await assert.rejects(
      review.stageHunk({ path: 'a.txt', hunk: 'no-at-header' }),
      /hunk 文本缺少 @@ 头/,
    );
  });
});
