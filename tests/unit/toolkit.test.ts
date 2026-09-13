import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteFileTool } from '../../src/adapters/tool/fs/writeFileTool.js';
import { ListDirTool } from '../../src/adapters/tool/fs/listDirTool.js';
import { ApplyPatchTool } from '../../src/adapters/tool/fs/applyPatchTool.js';
import { WebSearchTool } from '../../src/adapters/tool/web/webSearchTool.js';
import { PatchApplier } from '../../src/adapters/tool/fs/patchApplier.js';

/** 测试上下文。 */
const context = { sessionId: 's1', workspaceRoot: process.cwd() };

test('WriteFileTool：写入新文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-'));
  const tool = new WriteFileTool(dir);
  const result = await tool.handle(
    { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'hello' } },
    context,
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(await readFile(join(dir, 'a.txt'), 'utf8'), 'hello');
  await rm(dir, { recursive: true, force: true });
});

test('WriteFileTool：覆盖时生成 .bak 备份', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-'));
  await writeFile(join(dir, 'a.txt'), 'old', 'utf8');
  const tool = new WriteFileTool(dir);
  const result = await tool.handle(
    { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'new' } },
    context,
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(await readFile(join(dir, 'a.txt'), 'utf8'), 'new');
  assert.strictEqual(await readFile(join(dir, 'a.txt.bak'), 'utf8'), 'old');
  await rm(dir, { recursive: true, force: true });
});

test('WriteFileTool：越界路径拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-'));
  const tool = new WriteFileTool(dir);
  const result = await tool.handle(
    { id: 'c1', name: 'write_file', arguments: { path: '../evil.txt', content: 'x' } },
    context,
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /越界/);
  await rm(dir, { recursive: true, force: true });
});

test('ListDirTool：列出目录条目', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-'));
  await writeFile(join(dir, 'a.ts'), 'x', 'utf8');
  await rm(join(dir, 'a.ts'), { force: true });
  const tool = new ListDirTool(dir);
  const result = await tool.handle({ id: 'c1', name: 'list_dir', arguments: {} }, context);
  assert.strictEqual(result.ok, true);
  await rm(dir, { recursive: true, force: true });
});

test('ListDirTool：越界拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-'));
  const tool = new ListDirTool(dir);
  const result = await tool.handle(
    { id: 'c1', name: 'list_dir', arguments: { path: '..' } },
    context,
  );
  assert.strictEqual(result.ok, false);
  await rm(dir, { recursive: true, force: true });
});

test('PatchApplier：上下文补丁应用成功', () => {
  const applier = new PatchApplier();
  const patch = [
    '--- a/old.txt',
    '+++ b/old.txt',
    '@@ -1,3 +1,3 @@',
    ' line1',
    '-line2',
    '+LINE2',
    ' line3',
  ].join('\n');
  const result = applier.apply('line1\nline2\nline3', patch);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.newContent, 'line1\nLINE2\nline3');
  assert.strictEqual(result.targetFile, 'old.txt');
});

test('PatchApplier：上下文不匹配拒绝且不产生结果', () => {
  const applier = new PatchApplier();
  const patch = ['--- a/f', '+++ b/f', '@@ -1,1 +1,1 @@', '-wrong', '+right'].join('\n');
  const result = applier.apply('actual', patch);
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /不匹配/);
});

test('ApplyPatchTool：应用到工作区文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-'));
  await writeFile(join(dir, 'f.txt'), 'a\nb\nc', 'utf8');
  const tool = new ApplyPatchTool(dir);
  const patch = ['--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'].join(
    '\n',
  );
  const result = await tool.handle(
    { id: 'c1', name: 'apply_patch', arguments: { patch } },
    context,
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(await readFile(join(dir, 'f.txt'), 'utf8'), 'a\nB\nc');
  await rm(dir, { recursive: true, force: true });
});

test('ApplyPatchTool：失败不改动原文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-'));
  await writeFile(join(dir, 'f.txt'), 'original', 'utf8');
  const tool = new ApplyPatchTool(dir);
  const patch = ['--- a/f.txt', '+++ b/f.txt', '@@ -1,1 +1,1 @@', '-nope', '+yes'].join('\n');
  const result = await tool.handle(
    { id: 'c1', name: 'apply_patch', arguments: { patch } },
    context,
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(await readFile(join(dir, 'f.txt'), 'utf8'), 'original');
  await rm(dir, { recursive: true, force: true });
});

test('WebSearchTool：未配置明确提示', async () => {
  const tool = new WebSearchTool();
  const result = await tool.handle(
    { id: 'c1', name: 'web_search', arguments: { query: 'x' } },
    context,
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /未配置搜索服务/);
});

test('WebSearchTool：注入实现可搜索', async () => {
  const tool = new WebSearchTool({ search: async (query) => `结果: ${query}` });
  const result = await tool.handle(
    { id: 'c1', name: 'web_search', arguments: { query: 'OmniHarness' } },
    context,
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.output, '结果: OmniHarness');
});
