import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditFileTool } from '../../src/adapters/tool/fs/editFileTool.js';

const context = { sessionId: 's1', workspaceRoot: process.cwd() };

test('EditFileTool：按内容替换并保留 .bak 备份', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-edit-'));
  try {
    await writeFile(join(dir, 'a.ts'), 'const a = 1;\n', 'utf8');
    const tool = new EditFileTool(dir);
    const result = await tool.handle(
      {
        id: 'c1',
        name: 'edit',
        arguments: { path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
      },
      context,
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.output ?? '', /已替换 1 处/);
    assert.strictEqual(await readFile(join(dir, 'a.ts'), 'utf8'), 'const a = 2;\n');
    assert.strictEqual(await readFile(join(dir, 'a.ts.bak'), 'utf8'), 'const a = 1;\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('EditFileTool：命中歧义时拒绝且不改动文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-edit-'));
  try {
    await writeFile(join(dir, 'a.ts'), 'const a = 1;\nconst a = 1;\n', 'utf8');
    const tool = new EditFileTool(dir);
    const result = await tool.handle(
      {
        id: 'c1',
        name: 'edit',
        arguments: { path: 'a.ts', old_string: 'const a = 1;', new_string: 'x' },
      },
      context,
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /出现 2 次/);
    assert.strictEqual(await readFile(join(dir, 'a.ts'), 'utf8'), 'const a = 1;\nconst a = 1;\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('EditFileTool：整段粘贴 read_file 带行号内容时仍能替换', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-edit-'));
  try {
    await writeFile(join(dir, 'a.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
    const tool = new EditFileTool(dir);
    const result = await tool.handle(
      {
        id: 'c1',
        name: 'edit',
        arguments: {
          path: 'a.ts',
          old_string: '1→const a = 1;\n2→const b = 2;',
          new_string: 'const a = 10;\nconst b = 20;',
        },
      },
      context,
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.output ?? '', /行号前缀剥离匹配/);
    assert.strictEqual(await readFile(join(dir, 'a.ts'), 'utf8'), 'const a = 10;\nconst b = 20;\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('EditFileTool：文件不存在时提示改用 write_file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-edit-'));
  try {
    const tool = new EditFileTool(dir);
    const result = await tool.handle(
      { id: 'c1', name: 'edit', arguments: { path: 'nope.ts', old_string: 'a', new_string: 'b' } },
      context,
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /write_file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('EditFileTool：越界路径拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-edit-'));
  try {
    const tool = new EditFileTool(dir);
    const result = await tool.handle(
      {
        id: 'c1',
        name: 'edit',
        arguments: { path: '../evil.ts', old_string: 'a', new_string: 'b' },
      },
      context,
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /越界/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
