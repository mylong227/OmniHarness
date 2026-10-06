import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PatchApplier } from '../../src/adapters/tool/fs/patchApplier.js';
import { ApplyPatchTool } from '../../src/adapters/tool/fs/applyPatchTool.js';

/**
 * fs 工具上下文：根**必须与工具自身的根一致**。
 *
 * 2026-10-06（第六十一轮真实模型跑测）：fs 工具族统一为「运行时 ctx 优先」（`ToolWorkspaceRoot`）。
 * 此前本文件的 ctx 用 `process.cwd()`、工具根用临时目录，却断言补丁落在临时目录——那等于
 * **把「装配根优先」这一旧行为钉成契约**，而它正是子智能体隔离失效（补丁写进主工作区）的根因。
 */
const ctxOf = (dir: string): { sessionId: string; workspaceRoot: string } => ({
  sessionId: 's1',
  workspaceRoot: dir,
});

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

test('PatchApplier：hunk 体内空行按空上下文行处理（2026-10-03 修 T3，模型手写 diff 剥行尾空格）', () => {
  // 目标文件含真实空行；补丁的空上下文行是**空串**（传输层剥掉行尾空格的形态）。
  // 旧实现直接丢弃空行 ⇒ oldSide 少一行 ⇒ 声明位置 ±200 行都匹配不上，整份补丁被拒。
  const patch = ['--- a/f.txt', '+++ b/f.txt', '@@ -1,4 +1,4 @@', ' a', ' ', '-b', '+B', ' c'].join(
    '\n',
  );
  const result = new PatchApplier().apply('a\n\nb\nc', patch);
  assert.strictEqual(result.ok, true, `空上下文行必须被保留：${JSON.stringify(result.error)}`);
  assert.strictEqual(result.newContent, 'a\n\nB\nc');
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
      ctxOf(dir),
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
      ctxOf(dir),
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
      ctxOf(dir),
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
      ctxOf(dir),
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
      ctxOf(dir),
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

/**
 * 造一份「两个文件都要改」的补丁。
 * @returns unified diff 文本（one.txt: x→X，two.txt: y→Y）
 */
function twoFilePatch(): string {
  return [
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
}

test('ApplyPatchTool：覆盖已有文件前生成 .bak 备份（与 write_file / edit 同口径）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-patch-'));
  try {
    await writeFile(join(dir, 'one.txt'), 'x', 'utf8');
    await writeFile(join(dir, 'two.txt'), 'y', 'utf8');
    const tool = new ApplyPatchTool(dir);
    const result = await tool.handle(
      { id: 'c1', name: 'apply_patch', arguments: { patch: twoFilePatch() } },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(await readFile(join(dir, 'one.txt.bak'), 'utf8'), 'x');
    assert.strictEqual(await readFile(join(dir, 'two.txt.bak'), 'utf8'), 'y');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ApplyPatchTool：目标不可写时**一个字节都不落盘**（旧实现留下半份补丁，§3-6 回归判据）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-patch-'));
  try {
    await writeFile(join(dir, 'one.txt'), 'x', 'utf8');
    // two.txt 建成**目录**：读取即 EISDIR（非 ENOENT）⇒ 必须在准备阶段就整份拒绝。
    // 旧实现把读不到的路径当「新建文件」，先写成功 one.txt，再在 two.txt 上失败——用户收到
    // 「失败」，工作区却已经被改了（类文档承诺「原子」名不副实）。
    await mkdir(join(dir, 'two.txt'));
    const tool = new ApplyPatchTool(dir);
    const result = await tool.handle(
      { id: 'c1', name: 'apply_patch', arguments: { patch: twoFilePatch() } },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /two\.txt/);
    assert.strictEqual(await readFile(join(dir, 'one.txt'), 'utf8'), 'x', '不得留下半份补丁');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ApplyPatchTool：提交阶段写失败时回滚已写文件（工作区保持补丁前状态）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-patch-'));
  const second = join(dir, 'two.txt');
  try {
    await writeFile(join(dir, 'one.txt'), 'x', 'utf8');
    await writeFile(second, 'y', 'utf8');
    // 只读属性：Windows / POSIX 都让 writeFile 失败，而 `.bak`（新文件）仍可创建
    // ⇒ 恰好落在「准备成功、提交中途失败」这一格，正是需要回滚的那一格。
    await chmod(second, 0o444);
    const tool = new ApplyPatchTool(dir);
    const result = await tool.handle(
      { id: 'c1', name: 'apply_patch', arguments: { patch: twoFilePatch() } },
      ctxOf(dir),
    );
    if (result.ok) {
      // 少数文件系统/权限模型下只读不拦写入（如以 root 运行）：此时断言等价于成功路径，
      // 不让用例变成假红——真正不可写环境的判据由上一例（EISDIR）保证。
      assert.strictEqual(await readFile(join(dir, 'one.txt'), 'utf8'), 'X');
      return;
    }
    assert.strictEqual(await readFile(join(dir, 'one.txt'), 'utf8'), 'x', 'one.txt 必须被回滚');
    assert.match(result.error ?? '', /回滚/);
  } finally {
    await chmod(second, 0o666).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});
