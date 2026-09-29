// GraphStore 有界读取（审计 §30 Gap ⑤）单元测试。
// 覆盖：readBounded 对超 MAX_GRAPH_BYTES(4MiB) 的文件 fail-closed 抛错；
// list() 跳过超大文件（不静默 OOM、不阻断其余）；get() 显式暴露错误。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../../src/autonomy/graphStore.js';
import type { WorkflowDef } from '../../src/autonomy/workflowTypes.js';

const BIG: WorkflowDef = {
  name: 'oversized',
  steps: [{ id: 'a', prompt: 'X'.repeat(5 * 1024 * 1024) }],
};

test('GraphStore：超大图文件在 get 时 fail-closed 抛错（拒绝整文件读入内存）', () => {
  const root = mkdtempSync(join(tmpdir(), 'oh-graph-big-'));
  const store = new GraphStore(root);
  const gdir = join(root, '.omniharness', 'graphs');
  mkdirSync(gdir, { recursive: true });
  writeFileSync(join(gdir, 'oversized.json'), JSON.stringify(BIG), 'utf8');
  assert.throws(() => store.get('oversized'), /图文件过大|拒绝/);
  rmSync(root, { recursive: true, force: true });
});

test('GraphStore：list 跳过超大文件且不抛错（不阻断其余图）', () => {
  const root = mkdtempSync(join(tmpdir(), 'oh-graph-big2-'));
  const store = new GraphStore(root);
  const gdir = join(root, '.omniharness', 'graphs');
  mkdirSync(gdir, { recursive: true });
  writeFileSync(join(gdir, 'oversized.json'), JSON.stringify(BIG), 'utf8');
  writeFileSync(
    join(gdir, 'good.json'),
    JSON.stringify({ name: 'good', steps: [{ id: 'a', prompt: 'p' }] } as WorkflowDef),
    'utf8',
  );
  // list 不得抛错，且只保留好文件。
  const listed = store.list();
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0]!.id, 'good');
  rmSync(root, { recursive: true, force: true });
});
