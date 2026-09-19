import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadFileTool } from '../../src/adapters/tool/fs/readFileTool.js';

const tool = new ReadFileTool();

test('ReadFileTool：默认带行号并附定位脚注', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-read-'));
  try {
    await writeFile(join(dir, 'a.ts'), 'one\ntwo\nthree', 'utf8');
    const result = await tool.handle(
      { id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } },
      { sessionId: 's1', workspaceRoot: dir },
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.output ?? '', /1→one/);
    assert.match(result.output ?? '', /共 3 行；本次返回 1-3/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ReadFileTool：offset/limit 定点读取并提示剩余行数', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-read-'));
  try {
    await writeFile(join(dir, 'a.ts'), 'one\ntwo\nthree\nfour', 'utf8');
    const result = await tool.handle(
      { id: 'c1', name: 'read_file', arguments: { path: 'a.ts', offset: 2, limit: 1 } },
      { sessionId: 's1', workspaceRoot: dir },
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.output ?? '', /2→two/);
    assert.match(result.output ?? '', /还有 2 行未返回/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ReadFileTool：numbered=false 时逐字返回原文', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-read-'));
  try {
    await writeFile(join(dir, 'a.ts'), 'one\ntwo', 'utf8');
    const result = await tool.handle(
      { id: 'c1', name: 'read_file', arguments: { path: 'a.ts', numbered: false } },
      { sessionId: 's1', workspaceRoot: dir },
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.output ?? '', /^one\ntwo\n\[a\.ts 共 2 行/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ReadFileTool：offset 越过末尾时报错并给出总行数', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-read-'));
  try {
    await writeFile(join(dir, 'a.ts'), 'one', 'utf8');
    const result = await tool.handle(
      { id: 'c1', name: 'read_file', arguments: { path: 'a.ts', offset: 5 } },
      { sessionId: 's1', workspaceRoot: dir },
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /共 1 行/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ReadFileTool：空文件给出明确提示', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-read-'));
  try {
    await writeFile(join(dir, 'empty.ts'), '', 'utf8');
    const result = await tool.handle(
      { id: 'c1', name: 'read_file', arguments: { path: 'empty.ts' } },
      { sessionId: 's1', workspaceRoot: dir },
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.output ?? '', /空文件/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ReadFileTool：越界路径拒绝', async () => {
  const result = await tool.handle(
    { id: 'c1', name: 'read_file', arguments: { path: '../outside.txt' } },
    { sessionId: 's1', workspaceRoot: process.cwd() },
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /越界/);
});
