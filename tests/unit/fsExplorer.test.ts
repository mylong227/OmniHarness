import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { FsExplorer } from '../../src/server/fsExplorer.js';

/** 在临时目录内执行并在结束后清理。 */
function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'fs-explorer-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('FsExplorer.browse：空路径返回盘符层（含 home）', () => {
  const out = new FsExplorer().browse({}) as { level: string; roots: string[]; home: string };
  assert.strictEqual(out.level, 'drives');
  assert.ok(Array.isArray(out.roots));
  assert.ok(out.home.length > 0);
});

test('FsExplorer.browse：目录层返回排序子目录，includeFiles 时附带文件 mediaType', () => {
  withTemp((dir) => {
    mkdirSync(join(dir, 'b-dir'));
    mkdirSync(join(dir, 'a-dir'));
    writeFileSync(join(dir, 'note.md'), '# hi');
    const explorer = new FsExplorer();

    const dirsOnly = explorer.browse({ path: dir }) as {
      level: string;
      path: string;
      dirs: string[];
      files?: unknown[];
    };
    assert.strictEqual(dirsOnly.level, 'dir');
    assert.deepEqual(dirsOnly.dirs, ['a-dir', 'b-dir']);
    assert.strictEqual(dirsOnly.files, undefined);

    const withFiles = explorer.browse({ path: dir, includeFiles: true }) as {
      files: { name: string; size: number; mediaType: string }[];
    };
    assert.strictEqual(withFiles.files.length, 1);
    assert.strictEqual(withFiles.files[0]?.name, 'note.md');
    assert.strictEqual(withFiles.files[0]?.mediaType, 'text/markdown');
  });
});

test('FsExplorer.browse：返回规范绝对路径并回填 parent', () => {
  withTemp((dir) => {
    const out = new FsExplorer().browse({ path: dir }) as { path: string; parent?: string };
    assert.strictEqual(out.path, resolve(dir));
    assert.strictEqual(out.parent, dirname(resolve(dir)));
  });
});

test('FsExplorer.browse：不可读目录抛可读错误', () => {
  withTemp((dir) => {
    const missing = resolve(dir, 'nope');
    assert.throws(() => new FsExplorer().browse({ path: missing }), /无法读取目录/);
  });
});

test('FsExplorer.mkdir：创建子目录并返回绝对路径', () => {
  withTemp((dir) => {
    const out = new FsExplorer().mkdir({ parent: dir, name: 'new-proj' }) as { path: string };
    assert.strictEqual(out.path, join(dir, 'new-proj'));
  });
});

test('FsExplorer.mkdir：拒绝空名 / 越级名 / 已存在', () => {
  withTemp((dir) => {
    const explorer = new FsExplorer();
    assert.throws(() => explorer.mkdir({ parent: dir, name: '   ' }), /名称不能为空/);
    assert.throws(() => explorer.mkdir({ parent: dir, name: '..' }), /非法的文件夹名称/);
    mkdirSync(join(dir, 'dup'));
    assert.throws(() => explorer.mkdir({ parent: dir, name: 'dup' }), /已存在/);
    assert.throws(() => explorer.mkdir({}), /请先进入一个目录/);
  });
});

test('FsExplorer.mkdir：名称中的路径分隔符被清洗，只在 parent 内落盘', () => {
  withTemp((dir) => {
    const out = new FsExplorer().mkdir({ parent: dir, name: 'a/b' }) as { path: string };
    assert.strictEqual(out.path, join(dir, 'ab'), '分隔符应被剔除，绝不可越级建目录');
  });
});

test('FsExplorer.mkdir：父目录不存在时 fail-closed', () => {
  withTemp((dir) => {
    assert.throws(
      () => new FsExplorer().mkdir({ parent: resolve(dir, 'ghost'), name: 'x' }),
      /父目录不存在/,
    );
  });
});

test('FsExplorer.readAttachments：白名单内文件读为 base64，非法项进 errors 不阻断', () => {
  withTemp((dir) => {
    const txt = join(dir, 'a.txt');
    const bin = join(dir, 'b.exe');
    writeFileSync(txt, 'hello');
    writeFileSync(bin, 'MZ');
    const out = new FsExplorer().readAttachments({ paths: [txt, bin, 42, ''] }) as {
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

test('FsExplorer.readAttachments：paths 非数组或超量即抛错', () => {
  const explorer = new FsExplorer();
  assert.throws(() => explorer.readAttachments({}), /paths 必须是非空数组/);
  assert.throws(() => explorer.readAttachments({ paths: [] }), /paths 必须是非空数组/);
  const many = Array.from({ length: 51 }, (_v, i) => `f${i}.txt`);
  assert.throws(() => explorer.readAttachments({ paths: many }), /单次最多附加 50 个文件/);
});
