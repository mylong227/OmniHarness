import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceChanges } from '../../src/server/workspaceChanges.js';
import type { SessionEvent } from '../../src/ports/event.js';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = gitAvailable ? false : 'git 不可用，跳过 git 用例';

/** 造一段含单文件增删的 unified diff。 */
const SAMPLE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1,2 @@',
  ' const a = 1;',
  '+const b = 2;',
].join('\n');

/** 构造 turn_diff 事件。 */
function turnDiff(diff: string): SessionEvent {
  return {
    id: 'e',
    type: 'turn_diff',
    sessionId: 's',
    timestamp: '2026-09-11T00:00:00.000Z',
    payload: { diff },
  };
}

/** 构造服务（工作区根与线程枚举可配）。 */
function build(
  ws: string,
  threadIds: readonly string[],
  replay: () => Promise<readonly SessionEvent[]>,
): WorkspaceChanges {
  return new WorkspaceChanges({
    workspaceRoot: () => ws,
    threadIds: () => threadIds,
    replay,
  });
}

/** 在临时目录内执行并在结束后清理。 */
async function withTemp<T>(fn: (ws: string) => Promise<T>): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'ws-changes-'));
  try {
    return await fn(ws);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

test('WorkspaceChanges：非 git 工作区回退会话 turn_diff 聚合', async () => {
  await withTemp(async (ws) => {
    const changes = build(ws, ['t1'], async () => [turnDiff(SAMPLE_DIFF)]);
    const out = (await changes.list({})) as {
      source: string;
      files: { path: string; status: string; additions: number; deletions: number }[];
    };
    assert.strictEqual(out.source, 'session');
    assert.deepEqual(out.files, [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 }]);
  });
});

test('WorkspaceChanges：回放多个线程时同文件增删累加', async () => {
  await withTemp(async (ws) => {
    const changes = build(ws, ['t1', 't2'], async () => [turnDiff(SAMPLE_DIFF)]);
    const out = (await changes.list({})) as { files: { path: string; additions: number }[] };
    assert.strictEqual(out.files.length, 1);
    assert.strictEqual(out.files[0]?.additions, 2);
  });
});

test('WorkspaceChanges：指定 path 时返回该文件 patch', async () => {
  await withTemp(async (ws) => {
    const changes = build(ws, ['t1'], async () => [turnDiff(SAMPLE_DIFF)]);
    const out = (await changes.list({ path: 'src/a.ts' })) as { source: string; patch: string };
    assert.strictEqual(out.source, 'session');
    assert.match(out.patch, /\+\+\+ b\/src\/a\.ts/);
    assert.match(out.patch, /\+const b = 2;/);
  });
});

test('WorkspaceChanges：回放抛错时静默跳过该线程', async () => {
  await withTemp(async (ws) => {
    const changes = build(ws, ['t1'], async () => {
      throw new Error('storage 挂了');
    });
    const out = (await changes.list({})) as { source: string; files: unknown[] };
    assert.strictEqual(out.source, 'session');
    assert.deepEqual(out.files, []);
  });
});

test('WorkspaceChanges：git 工作区返回真实变更清单', { skip }, async () => {
  await withTemp(async (ws) => {
    spawnSync('git', ['init'], { cwd: ws, encoding: 'utf8' });
    writeFileSync(join(ws, 'fresh.txt'), 'line1\nline2\n');
    const changes = build(ws, [], async () => []);
    const out = (await changes.list({})) as {
      source: string;
      files: { path: string; status: string; additions: number }[];
    };
    assert.strictEqual(out.source, 'git');
    const fresh = out.files.find((f) => f.path === 'fresh.txt');
    assert.ok(fresh !== undefined, '应包含未跟踪的新文件');
    assert.strictEqual(fresh.status, '??');
    assert.strictEqual(fresh.additions, 3);
  });
});

test('WorkspaceChanges：git 工作区指定 path 返回 patch', { skip }, async () => {
  await withTemp(async (ws) => {
    spawnSync('git', ['init'], { cwd: ws, encoding: 'utf8' });
    writeFileSync(join(ws, 'added.txt'), 'x\n');
    const changes = build(ws, [], async () => []);
    const out = (await changes.list({ path: 'added.txt' })) as { source: string; patch: string };
    assert.strictEqual(out.source, 'git');
    assert.match(out.patch, /\+x/);
  });
});
