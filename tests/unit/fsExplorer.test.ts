// FsExplorer 判据（2026-10-18：同步 IO → 异步 IO 后同步迁移为 await / assert.rejects）。
//
// 为什么改成异步：`browse` / `attach.read` 是 RPC 热路径，同步 `readdirSync` + 逐文件 `statSync`
// 会按住事件循环（网络盘/大目录可达数十毫秒），期间 SSE 心跳与其它 RPC 全部停摆。
// 行为契约（返回值形状、错误文案、fail-closed 语义）逐字不变——断言只多了 await。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { FsExplorer } from '../../src/server/services/fsExplorer.ts';

/** 在临时目录内执行并在结束后清理（支持异步回调）。 */
async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'fs-explorer-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('FsExplorer.browse：空路径返回盘符层（含 home）', async () => {
  const out = (await new FsExplorer().browse({})) as {
    level: string;
    roots: string[];
    home: string;
  };
  assert.strictEqual(out.level, 'drives');
  assert.ok(Array.isArray(out.roots));
  assert.ok(out.home.length > 0);
});

test('FsExplorer.browse：目录层返回排序子目录，includeFiles 时附带文件 mediaType', async () => {
  await withTemp(async (dir) => {
    mkdirSync(join(dir, 'b-dir'));
    mkdirSync(join(dir, 'a-dir'));
    writeFileSync(join(dir, 'note.md'), '# hi');
    const explorer = new FsExplorer();

    const dirsOnly = (await explorer.browse({ path: dir })) as {
      level: string;
      path: string;
      dirs: string[];
      files?: unknown[];
    };
    assert.strictEqual(dirsOnly.level, 'dir');
    assert.deepEqual(dirsOnly.dirs, ['a-dir', 'b-dir']);
    assert.strictEqual(dirsOnly.files, undefined);

    const withFiles = (await explorer.browse({ path: dir, includeFiles: true })) as {
      files: { name: string; size: number; mediaType: string }[];
    };
    assert.strictEqual(withFiles.files.length, 1);
    assert.strictEqual(withFiles.files[0]?.name, 'note.md');
    assert.strictEqual(withFiles.files[0]?.mediaType, 'text/markdown');
  });
});

test('FsExplorer.browse：返回规范绝对路径并回填 parent', async () => {
  await withTemp(async (dir) => {
    const out = (await new FsExplorer().browse({ path: dir })) as { path: string; parent?: string };
    assert.strictEqual(out.path, resolve(dir));
    assert.strictEqual(out.parent, dirname(resolve(dir)));
  });
});

test('FsExplorer.browse：不可读目录抛可读错误', async () => {
  await withTemp(async (dir) => {
    const missing = resolve(dir, 'nope');
    await assert.rejects(() => new FsExplorer().browse({ path: missing }), /无法读取目录/);
  });
});

test('FsExplorer.mkdir：创建子目录并返回绝对路径', async () => {
  await withTemp(async (dir) => {
    const out = (await new FsExplorer().mkdir({ parent: dir, name: 'new-proj' })) as {
      path: string;
    };
    assert.strictEqual(out.path, join(dir, 'new-proj'));
  });
});

test('FsExplorer.mkdir：拒绝空名 / 越级名 / 已存在', async () => {
  await withTemp(async (dir) => {
    const explorer = new FsExplorer();
    await assert.rejects(() => explorer.mkdir({ parent: dir, name: '   ' }), /名称不能为空/);
    await assert.rejects(() => explorer.mkdir({ parent: dir, name: '..' }), /非法的文件夹名称/);
    mkdirSync(join(dir, 'dup'));
    await assert.rejects(() => explorer.mkdir({ parent: dir, name: 'dup' }), /已存在/);
    await assert.rejects(() => explorer.mkdir({}), /请先进入一个目录/);
  });
});

test('FsExplorer.mkdir：名称中的路径分隔符被清洗，只在 parent 内落盘', async () => {
  await withTemp(async (dir) => {
    const out = (await new FsExplorer().mkdir({ parent: dir, name: 'a/b' })) as { path: string };
    assert.strictEqual(out.path, join(dir, 'ab'), '分隔符应被剔除，绝不可越级建目录');
  });
});

test('FsExplorer.mkdir：父目录不存在时 fail-closed', async () => {
  await withTemp(async (dir) => {
    await assert.rejects(
      () => new FsExplorer().mkdir({ parent: resolve(dir, 'ghost'), name: 'x' }),
      /父目录不存在/,
    );
  });
});

test('FsExplorer.readAttachments：白名单内文件读为 base64，非法项进 errors 不阻断', async () => {
  await withTemp(async (dir) => {
    const txt = join(dir, 'a.txt');
    const bin = join(dir, 'b.exe');
    writeFileSync(txt, 'hello');
    writeFileSync(bin, 'MZ');
    const out = (await new FsExplorer().readAttachments({ paths: [txt, bin, 42, ''] })) as {
      files: { name: string; mediaType: string; data: string; kind: string }[];
      errors: { path: string; error: string }[];
    };
    assert.strictEqual(out.files.length, 1);
    assert.strictEqual(out.files[0]?.name, 'a.txt');
    assert.strictEqual(out.files[0]?.kind, 'file');
    assert.strictEqual(Buffer.from(out.files[0]?.data ?? '', 'base64').toString('utf8'), 'hello');
    assert.strictEqual(out.errors.length, 3);
    assert.match(out.errors[0]?.error ?? '', /不支持的文件类型/);
    assert.strictEqual(out.errors[1]?.error, '路径无效');
    assert.strictEqual(out.errors[2]?.error, '路径无效');
  });
});

test('FsExplorer.readAttachments：paths 非数组或超量即抛错', async () => {
  const explorer = new FsExplorer();
  await assert.rejects(() => explorer.readAttachments({}), /paths 必须是非空数组/);
  await assert.rejects(() => explorer.readAttachments({ paths: [] }), /paths 必须是非空数组/);
  const many = Array.from({ length: 51 }, (_v, i) => `f${i}.txt`);
  await assert.rejects(() => explorer.readAttachments({ paths: many }), /单次最多附加 50 个文件/);
});
