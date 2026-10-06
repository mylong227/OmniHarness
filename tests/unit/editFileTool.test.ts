import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditFileTool } from '../../src/adapters/tool/fs/editFileTool.js';

/**
 * fs 工具上下文：根**必须与工具自身的根一致**。
 *
 * 2026-10-06（第六十一轮真实模型跑测）：fs 工具族统一为「运行时 ctx 优先」（`ToolWorkspaceRoot`）。
 * 此前本文件的 ctx 用 `process.cwd()`、工具根用临时目录，却断言文件落在临时目录——那等于
 * **把「装配根优先」这一旧行为钉成契约**，而它正是子智能体隔离失效（写进主工作区）的根因。
 */
const ctxOf = (dir: string): { sessionId: string; workspaceRoot: string } => ({
  sessionId: 's1',
  workspaceRoot: dir,
});

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
      ctxOf(dir),
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
      ctxOf(dir),
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
      ctxOf(dir),
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
      ctxOf(dir),
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
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /越界/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('EditFileTool：new_string 与 old_string 等价时空操作必须如实回报（不写盘、不报「已替换」）', async () => {
  // 编码能力缺口（2026-09-26）：旧实现照样写 `.bak`、照样回「已替换 1 处」，模型据此认为改动已落地，
  // 后续自证与结论全部建立在假事实上。修复后：显式回报无变化、不写盘、不留 `.bak`。
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-edit-'));
  try {
    const original = 'const a = 1;\n';
    await writeFile(join(dir, 'a.ts'), original, 'utf8');
    const tool = new EditFileTool(dir);
    const result = await tool.handle(
      {
        id: 'c1',
        name: 'edit',
        arguments: { path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 1;' },
      },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, true, '工具本身没有失败');
    assert.match(result.output ?? '', /无变化/);
    assert.ok(!/已替换/.test(result.output ?? ''), '不得再声称「已替换」');
    assert.strictEqual(await readFile(join(dir, 'a.ts'), 'utf8'), original, '内容不得变');
    await assert.rejects(() => readFile(join(dir, 'a.ts.bak'), 'utf8'), '空操作不应留下 .bak 备份');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
