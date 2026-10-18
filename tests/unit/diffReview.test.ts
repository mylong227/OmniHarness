import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSyncAsync } from '../helpers/childProcess.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiffReview } from '../../src/server/services/diffReview.ts';
import { RepoPathGuard } from '../../src/server/services/repoPathGuard.ts';

const gitAvailable =
  (await spawnSyncAsync('git', ['--version'], { encoding: 'utf8' })).status === 0;
const skip = !gitAvailable;

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

test(
  'DiffReview：hunk 不得夹带第二条补丁 / 多 @@ 头（防对守卫外文件 git apply）',
  { skip },
  async () => {
    await withRepo(true, async (ws, review) => {
      writeFileSync(join(ws, 'a.txt'), 'line\n', 'utf8');
      await review.stageFile({ path: 'a.txt' });
      const injected = [
        '@@ -1 +1 @@',
        '-line',
        '+changed',
        'diff --git a/victim.txt b/victim.txt',
        '--- a/victim.txt',
        '+++ b/victim.txt',
        '@@ -1 +1 @@',
        '-secret',
        '+pwned',
      ].join('\n');
      await assert.rejects(
        review.stageHunk({ path: 'a.txt', hunk: injected }),
        /只能包含一个 @@ 头|补丁头/u,
      );
      const headerOnly = ['@@ -1 +1 @@', '-line', '+changed', '--- a/victim.txt'].join('\n');
      await assert.rejects(review.stageHunk({ path: 'a.txt', hunk: headerOnly }), /补丁头/u);
    });
  },
);

test('DiffReview：路径含控制字符（换行）一律拒绝（防补丁头注入）', { skip }, async () => {
  await withRepo(true, async (_ws, review) => {
    await assert.rejects(review.stageFile({ path: 'a\nb.txt' }), /控制字符/u);
  });
});
