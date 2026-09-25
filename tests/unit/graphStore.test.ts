import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../../src/autonomy/graphStore.js';
import type { WorkflowDef } from '../../src/autonomy/workflowTypes.js';

function makeStore(): GraphStore {
  const root = mkdtempSync(join(tmpdir(), 'oh-graph-'));
  return new GraphStore(root);
}

const SAMPLE: WorkflowDef = {
  name: 'demo-pipeline',
  steps: [
    { id: 'a', prompt: '做 A' },
    { id: 'b', dependsOn: ['a'], prompt: '做 B' },
  ],
};

test('GraphStore：save → list → get → delete 闭环', () => {
  const store = makeStore();
  assert.deepStrictEqual(store.list(), [], '初始应为空');

  const id = store.save(SAMPLE);
  assert.strictEqual(id, 'demo-pipeline', 'id 应为 name 归一化');

  const listed = store.list();
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0]!.id, 'demo-pipeline');
  assert.strictEqual(listed[0]!.stepCount, 2);

  const got = store.get('demo-pipeline');
  assert.ok(got, '应可取回');
  assert.strictEqual(got!.name, 'demo-pipeline');
  assert.strictEqual(got!.steps.length, 2);

  assert.strictEqual(store.delete('demo-pipeline'), true, '删除应返回 true');
  assert.strictEqual(store.get('demo-pipeline'), undefined, '删除后不可取回');
  assert.deepStrictEqual(store.list(), [], '删除后为空');
});

test('GraphStore：name 归一化为安全文件名 id', () => {
  const store = makeStore();
  const id = store.save({ name: 'My Pipeline! @v2', steps: [{ id: 'x', prompt: 'p' }] });
  assert.strictEqual(id, 'my-pipeline-v2', '特殊字符应替换为连字符并去首尾');
  assert.ok(store.get(id), '按归一化 id 可取回');
});

test('GraphStore：缺 name / 空 steps 应 fail-closed 抛错', () => {
  const store = makeStore();
  assert.throws(() => store.save({ steps: [{ id: 'x', prompt: 'p' }] } as unknown as WorkflowDef));
  assert.throws(() => store.save({ name: 'ok', steps: [] }));
});

test('sanitize：归一化特殊字符为安全文件名', () => {
  assert.strictEqual(GraphStore.sanitize('My Pipeline! @v2'), 'my-pipeline-v2');
  assert.strictEqual(GraphStore.sanitize('  trim  '), 'trim');
  assert.strictEqual(GraphStore.sanitize('---'), '');
});

test('GraphStore：坏文件在 list 中跳过不阻断', () => {
  const root = mkdtempSync(join(tmpdir(), 'oh-g-bad-'));
  const store = new GraphStore(root);
  // 直接往 graphs 目录塞坏文件 + 好文件
  const gdir = join(root, '.omniharness', 'graphs');
  mkdirSync(gdir, { recursive: true });
  writeFileSync(join(gdir, 'bad.json'), '{ broken');
  writeFileSync(join(gdir, 'good.json'), JSON.stringify(SAMPLE));
  const listed = store.list();
  assert.strictEqual(listed.length, 1, '坏文件应被跳过，仅保留好文件');
  assert.strictEqual(listed[0]!.id, 'good');
  rmSync(root, { recursive: true, force: true });
});
