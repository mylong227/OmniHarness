// #OBS-11：safeReadFile 单测
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SafeFs } from '../../src/server/services/safeFs.ts';

const WS = await mkdtemp(join(tmpdir(), 'omni-safefs-'));

test('① 读工作区内文件', async () => {
  await writeFile(join(WS, 'a.txt'), 'hello');
  const r = SafeFs.safeReadFile(WS, 'a.txt');
  assert.strictEqual(r.ok, true);
  if (r.ok) {
    assert.strictEqual(r.size, 5);
    assert.strictEqual(r.buffer.toString('utf8'), 'hello');
  }
});

test('② 越界相对路径：../etc/passwd', () => {
  const r = SafeFs.safeReadFile(WS, '../etc/passwd');
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.strictEqual(r.error, '路径越界工作区');
});

test('③ 越界绝对路径', () => {
  // 平台中性：win32 用盘符绝对路径，POSIX 用 /etc 下的绝对路径——两者都不落工作区内
  //（POSIX 上 'D:/Windows/system.ini' 会被解析成**相对**路径，越界断言落空——CI 首跑实证）。
  const outside = process.platform === 'win32' ? 'D:/Windows/system.ini' : '/etc/hostname';
  const r = SafeFs.safeReadFile(WS, outside);
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.strictEqual(r.error, '路径越界工作区');
});

test('④ 不存在的文件：返回错误而非抛错', () => {
  const r = SafeFs.safeReadFile(WS, 'nope.txt');
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.match(r.error, /读取失败/);
});

test('⑤ 空工作区根 / 空路径：拒绝', () => {
  assert.strictEqual(SafeFs.safeReadFile('', 'a.txt').ok, false);
  assert.strictEqual(SafeFs.safeReadFile(WS, '').ok, false);
});

test('⑥ 子目录读取', async () => {
  await mkdir(join(WS, 'sub'));
  await writeFile(join(WS, 'sub/x.md'), '# hi');
  const r = SafeFs.safeReadFile(WS, 'sub/x.md');
  assert.strictEqual(r.ok, true);
  if (r.ok) assert.strictEqual(r.buffer.toString('utf8'), '# hi');
});

test('⑦ 符号链接 / junction 逃逸被拦截（词法在内、真实在外）', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'omni-safefs-outside-'));
  try {
    await writeFile(join(outside, 'secret.txt'), 'top-secret');
    const link = join(WS, 'junc');
    let linked = true;
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      linked = false; // 无权限建链的环境（如受限沙箱）
    }
    if (!linked) {
      // 不能静默 return 让用例以 passed 计入：记 skip，让统计看见“没跑”。
      t.skip();
      return;
    }
    const r = SafeFs.safeReadFile(WS, 'junc/secret.txt');
    assert.strictEqual(r.ok, false, '经链接逃逸到工作区外必须被拒');
    if (!r.ok) assert.strictEqual(r.error, '路径越界工作区');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test('⑧ 目录 / 非普通文件：拒绝而不是当成 0 字节空文件', async () => {
  // 2026-10-19 实测：Windows 上对目录 read 会成功返回 0 字节；若不判 isFile，`/files?path=dir`
  // 与网页预览都会把目录渲染成"空文件"。safeStat 同时给出 isFile 供预览源回落目录索引。
  await mkdir(join(WS, 'only-dir'));
  const read = SafeFs.safeReadFile(WS, 'only-dir');
  assert.strictEqual(read.ok, false);
  if (!read.ok) assert.match(read.error, /不是普通文件/u);
  const stat = SafeFs.safeStat(WS, 'only-dir');
  assert.strictEqual(stat.ok, true);
  if (stat.ok) assert.strictEqual(stat.isFile, false);
  const fileStat = SafeFs.safeStat(WS, 'sub/x.md');
  assert.strictEqual(fileStat.ok, true);
  if (fileStat.ok) assert.strictEqual(fileStat.isFile, true);
});

test('⑨ safeResolve：普通文件给 target/size，目录/越界拒绝（流式下载用）', () => {
  const ok = SafeFs.safeResolve(WS, 'a.txt');
  assert.strictEqual(ok.ok, true);
  if (ok.ok) {
    assert.strictEqual(ok.size, 5);
    assert.ok(ok.target.endsWith('a.txt'));
  }
  const dir = SafeFs.safeResolve(WS, 'only-dir');
  assert.strictEqual(dir.ok, false);
  if (!dir.ok) assert.match(dir.error, /不是普通文件/u);
  const outside = SafeFs.safeResolve(WS, '../etc/passwd');
  assert.strictEqual(outside.ok, false);
  if (!outside.ok) assert.strictEqual(outside.error, '路径越界工作区');
});

test('清理临时目录', async () => {
  await rm(WS, { recursive: true, force: true });
});
