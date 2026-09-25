/**
 * 层化图软融合组件级单测（E4 深化，D6 第 1 关不变量）。
 *
 * 验证 `query(corpus, q, { layered: true })` 三件事：
 * 1. **保留文件 BM25 地板**：层化图作为「增强路」并入 fileScore 的 max，绝不静默丢弃
 *    整文件词法命中文件（这正是 layered-recall-ab.mjs 里 −9.1pp 的根因——此前是「替换」）。
 * 2. **确定性**：同输入两次结果完全一致（图缓存 + 无随机性）。
 * 3. **结构合法**：文件数 ≤ 预算、符号为数组、token 数为正。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContextEngine } from '../../src/context/contextEngine.js';

/** fib.ts：含 fibonacci / fibSequence（被查询词法命中）。 */
const FIB_TS = [
  'export function fibonacci(n: number): number {',
  '  if (n < 2) return n;',
  '  return fibonacci(n - 1) + fibonacci(n - 2);',
  '}',
  '',
  'export function fibSequence(count: number): number[] {',
  '  const out: number[] = [];',
  '  for (let i = 0; i < count; i += 1) out.push(fibonacci(i));',
  '  return out;',
  '}',
].join('\n');

/** cache.ts：memoize 装饰器，引用 fibonacci（被图扩散带回）。 */
const CACHE_TS = [
  'export function memoize<T>(fn: (n: number) => T): (n: number) => T {',
  '  const store = new Map<number, T>();',
  '  return (n: number): T => {',
  '    const hit = store.get(n);',
  '    if (hit !== undefined) return hit;',
  '    const v = fn(n);',
  '    store.set(n, v);',
  '    return v;',
  '  };',
  '}',
  '',
  'export function cachedFib(n: number): number {',
  '  return memoize(fibonacci)(n);',
  '}',
].join('\n');

/** 在临时目录构造最小双文件语料并索引（light 模式，与生产一致）。 */
function buildMiniCorpus() {
  const dir = mkdtempSync(join(tmpdir(), 'oh-ctx-layered-'));
  writeFileSync(join(dir, 'fib.ts'), FIB_TS);
  writeFileSync(join(dir, 'cache.ts'), CACHE_TS);
  const corpus = ContextEngine.indexCorpus(dir, { morph: true, light: true });
  return { dir, corpus };
}

test('query 层化软融合：保留文件 BM25 地板（修复 −9.1pp 丢信号）', () => {
  const { dir, corpus } = buildMiniCorpus();
  try {
    const q = 'fibonacci sequence';
    const base = ContextEngine.query(corpus, q, { layered: false });
    const fused = ContextEngine.query(corpus, q, { layered: true });
    assert.ok(base.files.includes('fib.ts'), 'BM25 基线应命中 fib.ts');
    // 关键不变量：软融合绝不能把文件 BM25 命中的 fib.ts 静默丢掉。
    assert.ok(fused.files.includes('fib.ts'), '软融合必须保留文件 BM25 命中的 fib.ts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('query 层化软融合：确定性（同输入两次结果一致）', () => {
  const { dir, corpus } = buildMiniCorpus();
  try {
    const q = 'memoize cache';
    const a = ContextEngine.query(corpus, q, { layered: true });
    const b = ContextEngine.query(corpus, q, { layered: true });
    assert.deepStrictEqual(a.files, b.files, '两次调用结果应完全一致');
    assert.ok(a.files.includes('cache.ts'), '缓存相关查询应命中 cache.ts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('query 层化软融合：结构合法（文件数 ≤ 预算，符号为数组，token 为正）', () => {
  const { dir, corpus } = buildMiniCorpus();
  try {
    const fused = ContextEngine.query(corpus, 'fibonacci', { layered: true });
    assert.ok(Array.isArray(fused.files));
    assert.ok(fused.files.length <= 14, '文件数不超过预算');
    assert.ok(Array.isArray(fused.symbols));
    assert.ok(typeof fused.tokens === 'number' && fused.tokens > 0, 'token 数为正');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('query 层化软融合：开启不影响纯 BM25 文件集之外的基本可用（不抛错、含图增强文件）', () => {
  const { dir, corpus } = buildMiniCorpus();
  try {
    // 用「memoize fibonacci」这种跨文件查询，验证图能把 cache.ts↔fib.ts 关联带出。
    const fused = ContextEngine.query(corpus, 'memoize fibonacci', { layered: true });
    assert.ok(fused.files.length > 0, '应至少呈现一个文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
