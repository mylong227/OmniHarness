import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceTree } from '../../src/server/services/workspaceTree.js';

/** 在临时工作区内构造 WorkspaceTree 并执行。 */
function withWs<T>(fn: (ws: string, tree: WorkspaceTree) => T): T {
  const ws = mkdtempSync(join(tmpdir(), 'ws-tree-'));
  try {
    return fn(ws, new WorkspaceTree({ workspaceRoot: () => ws }));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

test('WorkspaceTree.list：递归列举目录并跳过隐藏项与 node_modules', () => {
  withWs((ws, tree) => {
    mkdirSync(join(ws, 'src'));
    mkdirSync(join(ws, 'node_modules'));
    mkdirSync(join(ws, '.git'));
    writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1;');
    const out = tree.list({}) as {
      root: string;
      tree: { name: string; type: string; children?: unknown[] }[];
    };
    assert.strictEqual(out.root, ws);
    assert.deepEqual(
      out.tree.map((n) => n.name),
      ['src'],
    );
    const src = out.tree[0] as { children: { name: string }[] };
    assert.deepEqual(
      src.children.map((n) => n.name),
      ['a.ts'],
    );
  });
});

test('WorkspaceTree.list：path 越界工作区即抛错（fail-closed）', () => {
  withWs((_ws, tree) => {
    assert.throws(() => tree.list({ path: '../outside' }), /路径越界工作区/);
  });
});

test('WorkspaceTree.list：depth=0 时不展开子项', () => {
  withWs((ws, tree) => {
    mkdirSync(join(ws, 'a'));
    const out = tree.list({ depth: 0 }) as { tree: unknown[] };
    assert.deepEqual(out.tree, []);
  });
});

test('WorkspaceTree.readFile：读取文本内容并返回元信息', () => {
  withWs((ws, tree) => {
    writeFileSync(join(ws, 'notes.txt'), 'hello world');
    const out = tree.readFile({ path: 'notes.txt' }) as {
      path: string;
      size: number;
      isBinary: boolean;
      truncated: boolean;
      content: string;
    };
    assert.strictEqual(out.content, 'hello world');
    assert.strictEqual(out.size, 11);
    assert.strictEqual(out.isBinary, false);
    assert.strictEqual(out.truncated, false);
  });
});

test('WorkspaceTree.readFile：超出 maxBytes 截断', () => {
  withWs((ws, tree) => {
    writeFileSync(join(ws, 'big.txt'), 'abcdefghij');
    const out = tree.readFile({ path: 'big.txt', maxBytes: 4 }) as {
      truncated: boolean;
      content: string;
    };
    assert.strictEqual(out.content, 'abcd');
    assert.strictEqual(out.truncated, true);
  });
});

test('WorkspaceTree.readFile：越界路径被 safeReadFile 拒绝', () => {
  withWs((_ws, tree) => {
    assert.throws(() => tree.readFile({ path: '../secret.txt' }));
  });
});

test('WorkspaceTree.readFile：二进制文件返回空内容标记 isBinary', () => {
  withWs((ws, tree) => {
    writeFileSync(join(ws, 'blob.bin'), Buffer.from([1, 0, 2, 3]));
    const out = tree.readFile({ path: 'blob.bin' }) as { isBinary: boolean; content: string };
    assert.strictEqual(out.isBinary, true);
    assert.strictEqual(out.content, '');
  });
});
