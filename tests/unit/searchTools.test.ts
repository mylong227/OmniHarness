import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrepTool } from '../../src/adapters/tool/fs/grepTool.js';
import { GlobTool } from '../../src/adapters/tool/fs/globTool.js';

/** 在临时目录里铺一棵小工作区树，返回根目录。 */
const makeWorkspace = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-search-'));
  await mkdir(join(dir, 'src', 'deep'), { recursive: true });
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'const a = 1;\nconst needle = 2;\n', 'utf8');
  await writeFile(join(dir, 'src', 'deep', 'b.ts'), 'export const needle = 3;\n', 'utf8');
  await writeFile(join(dir, 'README.md'), 'needle in docs\n', 'utf8');
  await writeFile(join(dir, 'node_modules', 'dep.ts'), 'const needle = 4;\n', 'utf8');
  return dir;
};

const ctx = (dir: string): { sessionId: string; workspaceRoot: string } => ({
  sessionId: 's1',
  workspaceRoot: dir,
});

test('GrepTool：content 模式给出「文件:行号:正文」与统计脚注', async () => {
  const dir = await makeWorkspace();
  try {
    const result = await new GrepTool(dir).handle(
      { id: 'c1', name: 'grep', arguments: { pattern: 'needle', path: 'src' } },
      ctx(dir),
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.output ?? '', /src\/a\.ts:2:const needle = 2;/);
    assert.match(result.output ?? '', /src\/deep\/b\.ts:1:export const needle = 3;/);
    assert.match(result.output ?? '', /\[grep: 扫描 \d+ 个文件，命中 2 处/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GrepTool：count / files_with_matches 两种输出模式', async () => {
  const dir = await makeWorkspace();
  try {
    const tool = new GrepTool(dir);
    const count = await tool.handle(
      { id: 'c1', name: 'grep', arguments: { pattern: 'needle', output_mode: 'count' } },
      ctx(dir),
    );
    assert.match(count.output ?? '', /src\/a\.ts: 1/);
    const files = await tool.handle(
      {
        id: 'c2',
        name: 'grep',
        arguments: { pattern: 'needle', output_mode: 'files_with_matches' },
      },
      ctx(dir),
    );
    assert.match(files.output ?? '', /src\/a\.ts \(1 处命中\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GrepTool：glob 过滤生效（*.ts 排除 README.md）', async () => {
  const dir = await makeWorkspace();
  try {
    const result = await new GrepTool(dir).handle(
      { id: 'c1', name: 'grep', arguments: { pattern: 'needle', glob: '*.ts' } },
      ctx(dir),
    );
    assert.strictEqual(result.ok, true);
    assert.doesNotMatch(result.output ?? '', /README\.md/);
    assert.match(result.output ?? '', /src\/a\.ts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GrepTool：默认忽略 node_modules（不越工作区直觉边界）', async () => {
  const dir = await makeWorkspace();
  try {
    const result = await new GrepTool(dir).handle(
      {
        id: 'c1',
        name: 'grep',
        arguments: { pattern: 'needle', output_mode: 'files_with_matches' },
      },
      ctx(dir),
    );
    assert.doesNotMatch(result.output ?? '', /node_modules/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GrepTool：跳过二进制文件并显式回报跳过数', async () => {
  const dir = await makeWorkspace();
  try {
    await writeFile(join(dir, 'blob.bin'), Buffer.from('needle\u0000needle', 'utf8'));
    const result = await new GrepTool(dir).handle(
      {
        id: 'c1',
        name: 'grep',
        arguments: { pattern: 'needle', output_mode: 'files_with_matches' },
      },
      ctx(dir),
    );
    assert.strictEqual(result.ok, true);
    assert.doesNotMatch(result.output ?? '', /blob\.bin/);
    assert.match(result.output ?? '', /跳过 1 个/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GrepTool：非法正则与空 pattern 均 fail-closed 报错', async () => {
  const dir = await makeWorkspace();
  try {
    const tool = new GrepTool(dir);
    const bad = await tool.handle(
      { id: 'c1', name: 'grep', arguments: { pattern: '([' } },
      ctx(dir),
    );
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error ?? '', /正则/);
    const empty = await tool.handle(
      { id: 'c2', name: 'grep', arguments: { pattern: '' } },
      ctx(dir),
    );
    assert.strictEqual(empty.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GlobTool：**/*.ts 命中任意深度且按工作区相对路径返回', async () => {
  const dir = await makeWorkspace();
  try {
    const result = await new GlobTool(dir).handle(
      { id: 'c1', name: 'glob', arguments: { pattern: '**/*.ts' } },
      ctx(dir),
    );
    assert.strictEqual(result.ok, true);
    assert.match(result.output ?? '', /src\/a\.ts/);
    assert.match(result.output ?? '', /src\/deep\/b\.ts/);
    assert.doesNotMatch(result.output ?? '', /node_modules/);
    assert.doesNotMatch(result.output ?? '', /README\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GlobTool：path 限定子目录、非法子目录报错', async () => {
  const dir = await makeWorkspace();
  try {
    const tool = new GlobTool(dir);
    const scoped = await tool.handle(
      { id: 'c1', name: 'glob', arguments: { pattern: '**/*.ts', path: 'src/deep' } },
      ctx(dir),
    );
    assert.strictEqual(scoped.ok, true);
    assert.match(scoped.output ?? '', /src\/deep\/b\.ts/);
    assert.doesNotMatch(scoped.output ?? '', /src\/a\.ts/);
    const missing = await tool.handle(
      { id: 'c2', name: 'glob', arguments: { pattern: '**/*.ts', path: 'nope' } },
      ctx(dir),
    );
    assert.strictEqual(missing.ok, false);
    const empty = await tool.handle(
      { id: 'c3', name: 'glob', arguments: { pattern: '' } },
      ctx(dir),
    );
    assert.strictEqual(empty.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
