// #OBS-11：safeReadFile 单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeReadFile } from '../../src/server/services/safeFs.js';

const WS = await mkdtemp(join(tmpdir(), 'omni-safefs-'));

test('① 读工作区内文件', async () => {
  await writeFile(join(WS, 'a.txt'), 'hello');
  const r = safeReadFile(WS, 'a.txt');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.size, 5);
    assert.equal(r.buffer.toString('utf8'), 'hello');
  }
});

test('② 越界相对路径：../etc/passwd', () => {
  const r = safeReadFile(WS, '../etc/passwd');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, '路径越界工作区');
});

test('③ 越界绝对路径：D:/Windows/system.ini', () => {
  const r = safeReadFile(WS, 'D:/Windows/system.ini');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, '路径越界工作区');
});

test('④ 不存在的文件：返回错误而非抛错', () => {
  const r = safeReadFile(WS, 'nope.txt');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /读取失败/);
});

test('⑤ 空工作区根 / 空路径：拒绝', () => {
  assert.equal(safeReadFile('', 'a.txt').ok, false);
  assert.equal(safeReadFile(WS, '').ok, false);
});

test('⑥ 子目录读取', async () => {
  await mkdir(join(WS, 'sub'));
  await writeFile(join(WS, 'sub/x.md'), '# hi');
  const r = safeReadFile(WS, 'sub/x.md');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.buffer.toString('utf8'), '# hi');
});

test('清理临时目录', async () => {
  await rm(WS, { recursive: true, force: true });
});
