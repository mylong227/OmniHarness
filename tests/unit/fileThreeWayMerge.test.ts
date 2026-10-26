/**
 * 文件工具的三方合并端到端判据（真文件 + 共享账本 + 协调器）。
 *
 * 场景刻意模拟「两个会话」：A 先 `read_file` 建立基线全文；B 用协调器直接写盘
 * （模拟另一会话，不更新 A 的账本）；A 再 `write_file`/`edit`。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadFileTool } from '../../src/adapters/tool/fs/readFileTool.ts';
import { WriteFileTool } from '../../src/adapters/tool/fs/writeFileTool.ts';
import { EditFileTool } from '../../src/adapters/tool/fs/editFileTool.ts';
import { ApplyPatchTool } from '../../src/adapters/tool/fs/applyPatchTool.ts';
import { WorkspaceFileCoordinator } from '../../src/adapters/tool/fs/workspaceFileCoordinator.ts';
import type { ToolContext } from '../../src/ports/tool/tool.ts';

/** 工具上下文（sessionId 决定基线归属）。 */
const ctxOf = (root: string, sessionId = 'session-A'): ToolContext => ({
  sessionId,
  workspaceRoot: root,
});

/** 在临时工作区内执行并清理协调器缓存。 */
async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'omni-3way-'));
  try {
    return await fn(dir);
  } finally {
    WorkspaceFileCoordinator.forget(dir);
    await rm(dir, { recursive: true, force: true });
  }
}

/** 用另一个会话的身份直接写盘（不更新 A 的账本）。 */
async function otherSessionWrites(dir: string, file: string, content: string): Promise<void> {
  await WorkspaceFileCoordinator.of(dir).withWrite(file, async (lease) => {
    await lease.write(content);
  });
}

test('① write_file：双方改不同区域 ⇒ 自动三方合并，两个改动都保留', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.ts');
    const base = 'line1\nline2\nline3\n';
    await writeFile(file, base, 'utf8');
    const read = await new ReadFileTool().handle(
      { id: 'r', name: 'read_file', arguments: { path: 'a.ts' } },
      ctxOf(dir),
    );
    assert.strictEqual(read.ok, true);
    await otherSessionWrites(dir, file, 'line1\nline2\nline3-other\n');
    const result = await new WriteFileTool(dir).handle(
      {
        id: 'w',
        name: 'write_file',
        arguments: { path: 'a.ts', content: 'line1-mine\nline2\nline3\n' },
      },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, true, result.error ?? '');
    assert.match(result.output ?? '', /自动三方合并/);
    assert.strictEqual(await readFile(file, 'utf8'), 'line1-mine\nline2\nline3-other\n');
  });
});

test('② write_file：双方改同一行 ⇒ 冲突拒绝，不覆盖对方', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.ts');
    await writeFile(file, 'line1\nline2\n', 'utf8');
    await new ReadFileTool().handle(
      { id: 'r', name: 'read_file', arguments: { path: 'a.ts' } },
      ctxOf(dir),
    );
    await otherSessionWrites(dir, file, 'line1-other\nline2\n');
    const result = await new WriteFileTool(dir).handle(
      { id: 'w', name: 'write_file', arguments: { path: 'a.ts', content: 'line1-mine\nline2\n' } },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /冲突/);
    assert.strictEqual(await readFile(file, 'utf8'), 'line1-other\nline2\n');
  });
});

test('③ edit：双方改不同区域 ⇒ 自动三方合并', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.ts');
    await writeFile(file, 'a\nb\nc\n', 'utf8');
    await new ReadFileTool().handle(
      { id: 'r', name: 'read_file', arguments: { path: 'a.ts' } },
      ctxOf(dir),
    );
    await otherSessionWrites(dir, file, 'a\nb\nc-other\n');
    const result = await new EditFileTool(dir).handle(
      { id: 'e', name: 'edit', arguments: { path: 'a.ts', old_string: 'a', new_string: 'A' } },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, true, result.error ?? '');
    assert.match(result.output ?? '', /自动合并/);
    assert.strictEqual(await readFile(file, 'utf8'), 'A\nb\nc-other\n');
  });
});

test('④ edit：双方改同一区域 ⇒ 冲突拒绝', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.ts');
    await writeFile(file, 'a\nb\n', 'utf8');
    await new ReadFileTool().handle(
      { id: 'r', name: 'read_file', arguments: { path: 'a.ts' } },
      ctxOf(dir),
    );
    await otherSessionWrites(dir, file, 'X\nb\n');
    const result = await new EditFileTool(dir).handle(
      { id: 'e', name: 'edit', arguments: { path: 'a.ts', old_string: 'a', new_string: 'A' } },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /冲突/);
    assert.strictEqual(await readFile(file, 'utf8'), 'X\nb\n');
  });
});

test('⑤ edit：锚点只存在于「外部改动后」的内容 ⇒ 仍要求重读（不拿陈旧基线硬合并）', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.ts');
    await writeFile(file, 'const a = 1;\n', 'utf8');
    await new ReadFileTool().handle(
      { id: 'r', name: 'read_file', arguments: { path: 'a.ts' } },
      ctxOf(dir),
    );
    await otherSessionWrites(dir, file, 'const a = 9;\n');
    const result = await new EditFileTool(dir).handle(
      {
        id: 'e',
        name: 'edit',
        arguments: { path: 'a.ts', old_string: 'const a = 9;', new_string: 'const a = 2;' },
      },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /read_file/);
    assert.strictEqual(await readFile(file, 'utf8'), 'const a = 9;\n');
  });
});

test('⑥ write_file：没有读基线时不瞎合并（退回拒绝/正常写）', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.ts');
    await writeFile(file, 'base\n', 'utf8');
    // 不读、直接写：没有基线全文 ⇒ 正常创建/覆盖路径（不触发三方合并）
    const result = await new WriteFileTool(dir).handle(
      { id: 'w', name: 'write_file', arguments: { path: 'a.ts', content: 'next\n' } },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, true);
    assert.ok(!/自动三方合并/.test(result.output ?? ''));
    assert.strictEqual(await readFile(file, 'utf8'), 'next\n');
  });
});

test('⑦ apply_patch：补丁基于基线、对方改别处 ⇒ 三方合并', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.ts');
    await writeFile(file, 'line1\nline2\nline3\n', 'utf8');
    await new ReadFileTool().handle(
      { id: 'r', name: 'read_file', arguments: { path: 'a.ts' } },
      ctxOf(dir),
    );
    await otherSessionWrites(dir, file, 'line1\nline2\nline3-other\n');
    const patch = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,3 @@',
      '-line1',
      '+line1-mine',
      ' line2',
      ' line3',
    ].join('\n');
    const result = await new ApplyPatchTool(dir).handle(
      { id: 'p', name: 'apply_patch', arguments: { patch } },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, true, result.error ?? '');
    assert.strictEqual(await readFile(file, 'utf8'), 'line1-mine\nline2\nline3-other\n');
  });
});

test('⑧ apply_patch：补丁与对方改同一行 ⇒ 冲突拒绝', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'a.ts');
    await writeFile(file, 'line1\nline2\nline3\n', 'utf8');
    await new ReadFileTool().handle(
      { id: 'r', name: 'read_file', arguments: { path: 'a.ts' } },
      ctxOf(dir),
    );
    await otherSessionWrites(dir, file, 'line1-other\nline2\nline3\n');
    const patch = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,3 @@',
      '-line1',
      '+line1-mine',
      ' line2',
      ' line3',
    ].join('\n');
    const result = await new ApplyPatchTool(dir).handle(
      { id: 'p', name: 'apply_patch', arguments: { patch } },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /冲突/);
    assert.strictEqual(await readFile(file, 'utf8'), 'line1-other\nline2\nline3\n');
  });
});
