import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileAsync } from '../helpers/childProcess.ts';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointManager } from '../../src/core/checkpointManager.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import { GitWorkspaceSnapshot } from '../../src/adapters/workspace/gitWorkspaceSnapshot.ts';

/** 在临时目录初始化 git 仓库并提交一个基线文件。 */
async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omni-ckpt-'));
  await execFileAsync('git', ['init', '-q'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
  await writeFile(join(root, 'a.txt'), 'v1', 'utf8');
  await execFileAsync('git', ['add', 'a.txt'], { cwd: root });
  await execFileAsync('git', ['commit', '-q', '-m', 'baseline'], { cwd: root });
  return root;
}

test('checkpoint 文件回滚：还原快照时刻磁盘内容 + 重建被删文件（对齐 /rewind 代码回滚）', async () => {
  const root = await initRepo();
  try {
    // 再提交一个基线文件 b.txt。
    await writeFile(join(root, 'b.txt'), 'v1', 'utf8');
    await execFileAsync('git', ['add', 'b.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-q', '-m', 'b'], { cwd: root });

    const storage = new MemoryStorage();
    const mgr = new CheckpointManager(storage, {
      snapshotter: new GitWorkspaceSnapshot(),
      workspaceRoot: root,
      stateDir: join(root, '.omni-checkpoints'),
    });

    // 快照时刻：修改 a.txt=v2、修改 b.txt=v2。
    await writeFile(join(root, 'a.txt'), 'v2', 'utf8');
    await writeFile(join(root, 'b.txt'), 'v2', 'utf8');
    const meta = await mgr.snapshot('sess1', 'cp1');
    assert.strictEqual(meta.hasFileSnapshot, true);

    // 快照之后：继续改动 a.txt=v3、删除 b.txt。
    await writeFile(join(root, 'a.txt'), 'v3', 'utf8');
    await rm(join(root, 'b.txt'));

    const rolled = await mgr.rollback('sess1', 'cp1');
    assert.strictEqual(rolled.label, 'cp1');

    // a.txt 回到快照时刻的 v2；b.txt 被删除后应重建为快照时刻的 v2（HEAD 版本）。
    assert.strictEqual(await readFile(join(root, 'a.txt'), 'utf8'), 'v2');
    assert.strictEqual(await readFile(join(root, 'b.txt'), 'utf8'), 'v2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkpoint 无 snapshotter 时仅回滚事件（向后兼容，hasFileSnapshot=false）', async () => {
  const storage = new MemoryStorage();
  const mgr = new CheckpointManager(storage, { workspaceRoot: process.cwd() });
  const meta = await mgr.snapshot('sess2', 'cp');
  assert.strictEqual(meta.hasFileSnapshot, false);
  await assert.doesNotReject(() => mgr.rollback('sess2', 'cp'), '纯事件回滚不应抛错');
});

test('GitWorkspaceSnapshot：rename 不得解析出伪路径；回滚恢复新路径并删除旧路径', async () => {
  const root = await initRepo();
  try {
    await execFileAsync('git', ['mv', 'a.txt', 'c.txt'], { cwd: root });
    const snap = await new GitWorkspaceSnapshot().capture(root);
    assert.deepStrictEqual(
      snap.entries.map((e) => e.relPath).sort(),
      ['a.txt', 'c.txt'],
      '只应有新旧两条路径，不得出现由第二个 NUL 片段误解析出的伪路径',
    );
    assert.strictEqual(snap.entries.find((e) => e.relPath === 'c.txt')?.content, 'v1');
    assert.strictEqual(
      snap.entries.find((e) => e.relPath === 'a.txt')?.content,
      null,
      '改名前旧路径在快照时刻已不存在 ⇒ 回滚时必须删除',
    );

    // 模拟会话期间：旧路径被重新创建、新路径被改写。回滚应回到快照时刻。
    await writeFile(join(root, 'a.txt'), 'recreated', 'utf8');
    await writeFile(join(root, 'c.txt'), 'v2', 'utf8');
    await new GitWorkspaceSnapshot().restore(root, snap);
    await assert.rejects(() => readFile(join(root, 'a.txt'), 'utf8'), /ENOENT/u);
    assert.strictEqual(await readFile(join(root, 'c.txt'), 'utf8'), 'v1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GitWorkspaceSnapshot：未跟踪文件在快照时刻捕获其磁盘内容（回滚时还原，而非删除）', async () => {
  const root = await initRepo();
  try {
    await writeFile(join(root, 'untracked.txt'), 'x', 'utf8');
    const snap = await new GitWorkspaceSnapshot().capture(root);
    const entry = snap.entries.find((e) => e.relPath === 'untracked.txt');
    assert.notStrictEqual(entry, undefined);
    assert.strictEqual(entry?.content, 'x', '未跟踪文件应捕获快照时刻的磁盘内容以便还原');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GitWorkspaceSnapshot：二进制文件回滚必须逐字节相等（不得按 UTF-8 解码损坏）', async () => {
  const root = await initRepo();
  try {
    const original = Buffer.from([0, 1, 2, 255, 254, 0, 128, 200, 10, 13, 0, 7]);
    await writeFile(join(root, 'bin.dat'), original);
    const snap = await new GitWorkspaceSnapshot().capture(root);
    const entry = snap.entries.find((e) => e.relPath === 'bin.dat');
    assert.notStrictEqual(entry, undefined);
    assert.strictEqual(
      entry?.encoding,
      'base64',
      '非 UTF-8 字节必须走 base64，而不是替换成 U+FFFD',
    );

    // 回滚前的现场：改坏它；restore 必须恢复快照时刻的原始字节。
    await writeFile(join(root, 'bin.dat'), Buffer.from([9, 9, 9]));
    await new GitWorkspaceSnapshot().restore(root, snap);
    const restored = await readFile(join(root, 'bin.dat'));
    assert.deepStrictEqual(restored, original, '二进制回滚必须逐字节相等');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GitWorkspaceSnapshot：超过单文件上限的条目标记 skipped，restore 保留现场而不是删除', async () => {
  const root = await initRepo();
  try {
    await writeFile(join(root, 'large.bin'), Buffer.alloc(64, 0xff));
    const snap = await new GitWorkspaceSnapshot({ maxFileBytes: 8 }).capture(root);
    const entry = snap.entries.find((e) => e.relPath === 'large.bin');
    assert.strictEqual(entry?.skipped, true);
    assert.match(String(entry?.skipReason), /too-large/u);

    // 现场改成可识别的内容；restore 若把 skipped 当成删除，会整文件消失。
    await writeFile(join(root, 'large.bin'), Buffer.from('keep-me'));
    await new GitWorkspaceSnapshot({ maxFileBytes: 8 }).restore(root, snap);
    assert.strictEqual(await readFile(join(root, 'large.bin'), 'utf8'), 'keep-me');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CheckpointManager：文件快照保留策略只留最近 N 个，并删除被淘汰的快照文件', async () => {
  const root = await initRepo();
  try {
    const storage = new MemoryStorage();
    const mgr = new CheckpointManager(storage, {
      snapshotter: new GitWorkspaceSnapshot(),
      workspaceRoot: root,
      stateDir: join(root, '.omni-checkpoints'),
      maxFileSnapshots: 1,
    });
    await writeFile(join(root, 'a.txt'), 'v2', 'utf8');
    await mgr.snapshot('sess-prune', 'cp1');
    await writeFile(join(root, 'a.txt'), 'v3', 'utf8');
    await mgr.snapshot('sess-prune', 'cp2');

    const list = await mgr.list('sess-prune');
    assert.deepStrictEqual(
      list.map((m) => m.label),
      ['cp2'],
      '只应保留最新一个文件快照',
    );
    await assert.rejects(
      () => stat(join(root, '.omni-checkpoints', 'sess-prune', 'cp1.files.json')),
      /ENOENT/u,
      '被淘汰的快照文件必须删除，不能只从索引里消失',
    );
    await assert.doesNotReject(() => mgr.rollback('sess-prune', 'cp2'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
