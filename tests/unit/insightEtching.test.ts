// (P3, I-P3-1) 利希滕贝格刻蚀记忆：分形分支树刻蚀 + 沿共振刻痕低阻导通 + fail-closed。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InsightEtchingEngine } from '../../src/adapters/memory/insightEtching.js';

test('① 刻蚀一次顿悟事件 → 分形分支树入介质，traces=1', () => {
  const e = new InsightEtchingEngine();
  const trace = e.etch({
    id: 'e1',
    label: '缓存失效根因定位',
    branches: [
      { label: '查命中率陡降', subBranches: [{ label: '比对监控面板' }] },
      { label: '查 TTL 被穿透' },
    ],
  });
  assert.strictEqual(trace.id, 'e1');
  assert.strictEqual(trace.root.label, '缓存失效根因定位');
  assert.strictEqual(trace.root.children.length, 2, '应刻出两条一级分支');
  assert.strictEqual(trace.root.children[0]!.children.length, 1, '分支可嵌套（分形）');
  assert.strictEqual(e.traces, 1);
});

test('② 沿共振刻痕低阻导通：命中 query 返回分支路径；无关 query 返回 []', () => {
  const e = new InsightEtchingEngine();
  e.etch({ id: 'e1', label: '缓存失效根因定位', branches: [{ label: '查命中率陡降' }] });
  // 同文本 → 共振=1，必命中。
  const hit = e.conduct('缓存失效根因定位');
  assert.strictEqual(hit.length, 1, '应命中 1 条 trace');
  assert.ok(hit[0]!.path.includes('查命中率陡降'), '路径应包含分支标签');
  // 完全无关 query（互不相交字符集）→ 共振 < 阈值，回落 []。
  const miss = e.conduct('苹果香蕉西瓜火车飞机轮船');
  assert.strictEqual(miss.length, 0, '无关 query 不应沿任何刻痕导通');
});

test('③ fail-closed：空 ID / 空标签 / 重复 ID 均抛错', () => {
  const e = new InsightEtchingEngine();
  assert.throws(() => e.etch({ id: '', label: 'x' }), '空 ID 应抛错');
  assert.throws(() => e.etch({ id: 'a', label: '' }), '空标签应抛错');
  e.etch({ id: 'dup', label: 'y' });
  assert.throws(() => e.etch({ id: 'dup', label: 'z' }), '重复 ID 应抛错');
});
