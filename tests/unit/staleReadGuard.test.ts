/**
 * 内容账本与陈旧读保护单测（S1，零依赖）。
 *
 * 覆盖：账本语义（未读不拦、已读被外部改动则拦、自身写入不算改）、
 * 以及 write_file / edit / apply_patch 三条写路径的接入表现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileContentLedger } from '../../src/adapters/tool/fs/fileContentLedger.js';
import { WriteFileTool } from '../../src/adapters/tool/fs/writeFileTool.js';
import { EditFileTool } from '../../src/adapters/tool/fs/editFileTool.js';
import { ApplyPatchTool } from '../../src/adapters/tool/fs/applyPatchTool.js';
import type { ToolContext } from '../../src/ports/tool/tool.js';

/** 工具上下文（workspaceRoot 由各用例注入）。 */
const ctxOf = (root: string): ToolContext => ({ sessionId: 's1', workspaceRoot: root });

test('账本：未记录的文件不拦；记录后内容变了才拦；forget 后恢复放行', () => {
  const ledger = new FileContentLedger();
  assert.strictEqual(ledger.changedSince('/x/a.ts', 'v1'), false, '从未读过 ⇒ 不拦');
  ledger.remember('/x/a.ts', 'v1');
  assert.strictEqual(ledger.changedSince('/x/a.ts', 'v1'), false, '内容一致 ⇒ 不拦');
  assert.strictEqual(ledger.changedSince('/x/a.ts', 'v2'), true, '内容背离 ⇒ 拦');
  assert.strictEqual(ledger.size(), 1);
  ledger.forget('/x/a.ts');
  assert.strictEqual(ledger.changedSince('/x/a.ts', 'v2'), false);
  assert.strictEqual(ledger.size(), 0);
});

test('冲突文案明确指向"先读后写"', () => {
  const message = FileContentLedger.conflictMessage('src/a.ts');
  assert.ok(message.includes('src/a.ts'));
  assert.ok(message.includes('read_file'));
});

test('write_file：外部改动后拒绝覆盖，重读后放行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
  try {
    const ledger = new FileContentLedger();
    const tool = new WriteFileTool(dir, ledger);
    await tool.handle(
      { id: 'c1', name: 'write_file', arguments: { path: 'a.ts', content: 'v1' } },
      ctxOf(dir),
    );
    assert.strictEqual(await readFile(join(dir, 'a.ts'), 'utf8'), 'v1');
    // 模拟"另一个会话"直接改盘
    await writeFile(join(dir, 'a.ts'), '外部改动', 'utf8');
    const blocked = await tool.handle(
      { id: 'c2', name: 'write_file', arguments: { path: 'a.ts', content: 'v2' } },
      ctxOf(dir),
    );
    assert.strictEqual(blocked.ok, false);
    assert.ok(blocked.error?.includes('read_file'));
    assert.strictEqual(await readFile(join(dir, 'a.ts'), 'utf8'), '外部改动', '冲突时不得落盘');
    // 重新记录当前内容后即可写入
    ledger.remember(join(dir, 'a.ts'), '外部改动');
    const again = await tool.handle(
      { id: 'c3', name: 'write_file', arguments: { path: 'a.ts', content: 'v2' } },
      ctxOf(dir),
    );
    assert.strictEqual(again.ok, true);
    assert.strictEqual(await readFile(join(dir, 'a.ts'), 'utf8'), 'v2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('write_file：本工具链连续写入不会自相冲突', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
  try {
    const tool = new WriteFileTool(dir, new FileContentLedger());
    for (const content of ['v1', 'v2', 'v3']) {
      const result = await tool.handle(
        { id: 'c', name: 'write_file', arguments: { path: 'a.ts', content } },
        ctxOf(dir),
      );
      assert.strictEqual(result.ok, true, `写 ${content} 应成功`);
    }
    assert.strictEqual(await readFile(join(dir, 'a.ts'), 'utf8'), 'v3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('edit：外部改动后拒绝改写', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
  try {
    const ledger = new FileContentLedger();
    const write = new WriteFileTool(dir, ledger);
    await write.handle(
      { id: 'c0', name: 'write_file', arguments: { path: 'a.ts', content: 'const a = 1;\n' } },
      ctxOf(dir),
    );
    await writeFile(join(dir, 'a.ts'), 'const a = 9;\n', 'utf8');
    const tool = new EditFileTool(dir, ledger);
    const blocked = await tool.handle(
      {
        id: 'c1',
        name: 'edit',
        arguments: { path: 'a.ts', old_string: 'a = 9', new_string: 'a = 2' },
      },
      ctxOf(dir),
    );
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(await readFile(join(dir, 'a.ts'), 'utf8'), 'const a = 9;\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('apply_patch：任一段目标冲突即整体不落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
  try {
    const ledger = new FileContentLedger();
    const write = new WriteFileTool(dir, ledger);
    await write.handle(
      { id: 'c0', name: 'write_file', arguments: { path: 'a.ts', content: 'one\n' } },
      ctxOf(dir),
    );
    await writeFile(join(dir, 'a.ts'), 'changed\n', 'utf8');
    const patch = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-changed', '+patched', ''].join(
      '\n',
    );
    const tool = new ApplyPatchTool(dir, ledger);
    const result = await tool.handle(
      { id: 'c1', name: 'apply_patch', arguments: { patch } },
      ctxOf(dir),
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(await readFile(join(dir, 'a.ts'), 'utf8'), 'changed\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
