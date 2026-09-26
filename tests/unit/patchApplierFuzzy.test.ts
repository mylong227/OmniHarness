import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PatchApplier } from '../../src/adapters/tool/fs/patchApplier.js';
import { ApplyPatchTool } from '../../src/adapters/tool/fs/applyPatchTool.js';

const context = { sessionId: 's1', workspaceRoot: process.cwd() };

/** 单文件补丁（上下文 3 行，把 b 改成 B）。 */
function patchOf(oldStart: number): string {
  return [
    `--- a/f.txt`,
    `+++ b/f.txt`,
    `@@ -${oldStart},3 +${oldStart},3 @@`,
    ' a',
    '-b',
    '+B',
    ' c',
  ].join('\n');
}

test('PatchApplier：精确补丁仍然逐字正确（零行为变更）', () => {
  const result = new PatchApplier().apply('a\nb\nc', patchOf(1));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.newContent, 'a\nB\nc');
  assert.strictEqual(result.targetFile, 'f.txt');
});

test('PatchApplier：行号写偏（-5 而实际在 -2）仍能落位', () => {
  // 探针里模型最常见的失败形态之一：hunk 头行号与实际行号不一致。
  const result = new PatchApplier().apply('a\nb\nc', patchOf(5));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.newContent, 'a\nB\nc');
});

test('PatchApplier：上下文行尾空白差异仍能落位', () => {
  const patch = ['--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,3 @@', ' a', '-b  ', '+B', ' c'].join(
    '\n',
  );
  const result = new PatchApplier().apply('a\nb\nc', patch);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.newContent, 'a\nB\nc');
});

test('PatchApplier：上下文误带行号前缀（read_file 输出粘贴）仍能落位', () => {
  const patch = ['--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,3 @@', '1→a', '-2→b', '3→c', '+B'].join(
    '\n',
  );
  const result = new PatchApplier().apply('a\nb\nc', patch);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.newContent, 'a\nB\nc');
});

test('PatchApplier：多文件补丁解析出全部 +++ 段（原实现只取首个头）', () => {
  const patch = [
    '--- a/one.txt',
    '+++ b/one.txt',
    '@@ -1,1 +1,1 @@',
    '-x',
    '+X',
    '--- a/two.txt',
    '+++ b/two.txt',
    '@@ -1,1 +1,1 @@',
    '-y',
    '+Y',
  ].join('\n');
  const parsed = new PatchApplier().parseFiles(patch);
  assert.strictEqual(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.deepStrictEqual(
    parsed.files.map((file) => file.targetFile),
    ['one.txt', 'two.txt'],
  );
  const applied = new PatchApplier().applyMany(
    new Map([
      ['one.txt', 'x'],
      ['two.txt', 'y'],
    ]),
    patch,
  );
  assert.strictEqual(applied.ok, true);
  if (!applied.ok) {
    return;
  }
  assert.deepStrictEqual(
    applied.outputs.map((output) => `${output.targetFile}=${output.content}`),
    ['one.txt=X', 'two.txt=Y'],
  );
});

test('PatchApplier：@@ -0,0 新文件补丁在空文件上落位到开头（原实现负下标插到末尾前）', () => {
  const patch = ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+first', '+second'].join(
    '\n',
  );
  const parsed = new PatchApplier().parseFiles(patch);
  // `--- /dev/null` 表示新建：+++ 头仍是真实目标，故可解析。
  assert.strictEqual(parsed.ok, true);
  const result = new PatchApplier().apply('', patch);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.newContent, 'first\nsecond');
});

test('PatchApplier：真正的上下文不匹配必须失败（负向对照，证明容错不是「永远成功」）', () => {
  const patch = ['--- a/f', '+++ b/f', '@@ -1,1 +1,1 @@', '-wrong', '+right'].join('\n');
  const result = new PatchApplier().apply('actual', patch);
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /不匹配/);
});

test('PatchApplier：多文件中任一段失败则整体失败（不产出任何文件）', () => {
  const patch = [
    '--- a/one.txt',
    '+++ b/one.txt',
    '@@ -1,1 +1,1 @@',
    '-x',
    '+X',
    '--- a/two.txt',
    '+++ b/two.txt',
    '@@ -1,1 +1,1 @@',
    '-nope',
    '+Y',
  ].join('\n');
  const applied = new PatchApplier().applyMany(
    new Map([
      ['one.txt', 'x'],
      ['two.txt', 'y'],
    ]),
    patch,
  );
  assert.strictEqual(applied.ok, false);
  if (!applied.ok) {
    assert.match(applied.error, /two\.txt/);
  }
});

test('ApplyPatchTool：一个补丁原子写入多个文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-patch-'));
  try {
    await writeFile(join(dir, 'one.txt'), 'x', 'utf8');
    await writeFile(join(dir, 'two.txt'), 'y', 'utf8');
    const patch = [
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+X',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -1,1 +1,1 @@',
      '-y',
      '+Y',
    ].join('\n');
    const tool = new ApplyPatchTool(dir);
    const result = await tool.handle(
      { id: 'c1', name: 'apply_patch', arguments: { patch } },
      context,
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(await readFile(join(dir, 'one.txt'), 'utf8'), 'X');
    assert.strictEqual(await readFile(join(dir, 'two.txt'), 'utf8'), 'Y');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ApplyPatchTool：任一段失败时两个文件都保持原样', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-patch-'));
  try {
    await writeFile(join(dir, 'one.txt'), 'x', 'utf8');
    await writeFile(join(dir, 'two.txt'), 'y', 'utf8');
    const patch = [
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+X',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -1,1 +1,1 @@',
      '-nope',
      '+Y',
    ].join('\n');
    const tool = new ApplyPatchTool(dir);
    const result = await tool.handle(
      { id: 'c1', name: 'apply_patch', arguments: { patch } },
      context,
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(await readFile(join(dir, 'one.txt'), 'utf8'), 'x');
    assert.strictEqual(await readFile(join(dir, 'two.txt'), 'utf8'), 'y');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ApplyPatchTool：单文件补丁仍可用 path 覆盖 +++ 头目标', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-patch-'));
  try {
    await writeFile(join(dir, 'real.txt'), 'a\nb\nc', 'utf8');
    const patch = [
      '--- a/ignored.txt',
      '+++ b/ignored.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ].join('\n');
    const tool = new ApplyPatchTool(dir);
    const result = await tool.handle(
      { id: 'c1', name: 'apply_patch', arguments: { patch, path: 'real.txt' } },
      context,
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(await readFile(join(dir, 'real.txt'), 'utf8'), 'a\nB\nc');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ApplyPatchTool：hunk 无增删行（纯上下文）时必须回报「未改变任何文件」', async () => {
  // 编码能力缺口（2026-09-26）：旧实现无条件回「补丁已应用到 1 个文件」，而此类补丁写入内容与
  // 原文件逐字节相同 ⇒ 模型把空操作读成「改好了」，后续自证与结论全建立在假事实上。
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-patch-'));
  try {
    const original = 'a\nb\nc';
    await writeFile(join(dir, 'f.txt'), original, 'utf8');
    const patch = ['--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,3 @@', ' a', ' b', ' c'].join('\n');
    const tool = new ApplyPatchTool(dir);
    const result = await tool.handle(
      { id: 'c1', name: 'apply_patch', arguments: { patch } },
      context,
    );
    assert.strictEqual(result.ok, true, '补丁本身可解析、可落位，不算工具失败');
    assert.match(result.output ?? '', /未改变任何文件/);
    assert.strictEqual(await readFile(join(dir, 'f.txt'), 'utf8'), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ApplyPatchTool：多文件补丁如实区分「变更」与「无变化」', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-patch-'));
  try {
    await writeFile(join(dir, 'one.txt'), 'a\nb\nc', 'utf8');
    await writeFile(join(dir, 'two.txt'), 'x\ny\nz', 'utf8');
    const patch = [
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -1,3 +1,3 @@',
      ' x',
      ' y',
      ' z',
    ].join('\n');
    const tool = new ApplyPatchTool(dir);
    const result = await tool.handle(
      { id: 'c1', name: 'apply_patch', arguments: { patch } },
      context,
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.output ?? '', /变更 1 个文件: one\.txt/);
    assert.match(result.output ?? '', /无变化（two\.txt）/);
    assert.strictEqual(await readFile(join(dir, 'one.txt'), 'utf8'), 'a\nB\nc');
    assert.strictEqual(await readFile(join(dir, 'two.txt'), 'utf8'), 'x\ny\nz');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
