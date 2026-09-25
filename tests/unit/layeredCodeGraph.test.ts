/**
 * 层化代码图单测（`src/context/layeredCodeGraph.ts`）。
 *
 * 重点验证三件事：
 * 1. 层坐标抽取（缩进 / 形参个数 / 模块）正确；
 * 2. 作用域归属正确——引用行归属给**所在作用域的宿主**，而非整个文件；
 * 3. **稀疏化且保真**：相比稠密图边数显著下降，同时真实关联一条不丢，
 *    而笛卡尔积产生的虚假关联（如 `epsilon ↔ betahelper`）被消除。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CodeGraphIndex } from '../../src/context/codeGraphIndex.js';
import { LayeredCodeGraph } from '../../src/context/layeredCodeGraph.js';
import type { SymbolNode } from '../../src/context/repoMap.js';

/** 构造符号节点的测试夹具。 */
function sym(file: string, line: number, name: string, signature: string): SymbolNode {
  return { file, line, kind: 'function', name, signature };
}

/** a.ts：三个函数，各引用（或不引用）不同的外部符号。 */
const FILE_A = [
  'export function alpha(one: string): void {', // L1
  '  betahelper(one);', // L2
  '}', // L3
  '', // L4
  'export function gamma(): void {', // L5
  '  deltasink();', // L6
  '}', // L7
  '', // L8
  'export function epsilon(): void {', // L9
  '}', // L10
].join('\n');

/** b.ts：被 alpha 引用。 */
const FILE_B = ['export function betahelper(x: string): number {', '  return 1;', '}'].join('\n');

/** c.ts：被 gamma 引用。 */
const FILE_C = ['export function deltasink(y: string): void {', '  return;', '}'].join('\n');

/** 四符号语料：alpha/gamma/epsilon 在 a.ts，betahelper 在 b.ts，deltasink 在 c.ts。 */
const SYMBOLS: readonly SymbolNode[] = [
  sym('a.ts', 1, 'alpha', 'export function alpha(one: string): void {'),
  sym('a.ts', 5, 'gamma', 'export function gamma(): void {'),
  sym('a.ts', 9, 'epsilon', 'export function epsilon(): void {'),
  sym('b.ts', 1, 'betahelper', 'export function betahelper(x: string): number {'),
  sym('c.ts', 1, 'deltasink', 'export function deltasink(y: string): void {'),
];

/** 最小语料视图。 */
const CORPUS = {
  symbols: SYMBOLS,
  fileText: new Map<string, string>([
    ['a.ts', FILE_A],
    ['b.ts', FILE_B],
    ['c.ts', FILE_C],
  ]),
};

test('indentOf：空格、制表符与混合缩进', () => {
  assert.strictEqual(LayeredCodeGraph.indentOf('no indent'), 0);
  assert.strictEqual(LayeredCodeGraph.indentOf('  two'), 2);
  assert.strictEqual(LayeredCodeGraph.indentOf('\tone tab'), 2);
  assert.strictEqual(LayeredCodeGraph.indentOf('\t  mixed'), 4);
});

test('arityOf：无参 / 单参 / 多参 / 嵌套泛型不误计', () => {
  assert.strictEqual(LayeredCodeGraph.arityOf('function f(): void'), 0);
  assert.strictEqual(LayeredCodeGraph.arityOf('function f()'), 0);
  assert.strictEqual(LayeredCodeGraph.arityOf('function f(a: string)'), 1);
  assert.strictEqual(LayeredCodeGraph.arityOf('function f(a: string, b: number): void'), 2);
  // Map<string, Array<number>> 里的逗号处于嵌套中，不应计入。
  assert.strictEqual(LayeredCodeGraph.arityOf('function f(m: Map<string, number[]>): void'), 1);
  // 无参数列表的构造器式签名记 0。
  assert.strictEqual(LayeredCodeGraph.arityOf('class Foo'), 0);
});

test('moduleOf：根目录 / 一级 / 多级目录', () => {
  assert.strictEqual(LayeredCodeGraph.moduleOf('index.ts'), '.');
  assert.strictEqual(LayeredCodeGraph.moduleOf('src/index.ts'), 'src');
  assert.strictEqual(LayeredCodeGraph.moduleOf('src/context/repoMap.ts'), 'src');
});

test('nodeLayers：导出性、模块与元数被正确填充', () => {
  const layers = LayeredCodeGraph.nodeLayers(SYMBOLS);
  assert.strictEqual(layers.length, SYMBOLS.length);
  assert.strictEqual(layers[0]?.exported, true, 'alpha 带 export');
  assert.strictEqual(layers[0]?.arity, 1, 'alpha 单参');
  assert.strictEqual(layers[0]?.module, '.', 'a.ts 在根目录');
  assert.strictEqual(layers[1]?.arity, 0, 'gamma 无参');
});

test('scopeOwners：引用行归属所在作用域的宿主，定义行不归属自己', () => {
  const lines = FILE_A.split('\n');
  const localSyms = [SYMBOLS[0]!, SYMBOLS[1]!, SYMBOLS[2]!];
  const owners = LayeredCodeGraph.scopeOwners(lines, localSyms, 120);

  assert.strictEqual(owners.length, lines.length);
  assert.strictEqual(owners[0], -1, 'alpha 的定义行不自归属');
  assert.strictEqual(owners[1], 0, 'L2 的 betahelper 调用归属 alpha');
  assert.strictEqual(owners[4], -1, 'gamma 的定义行不自归属');
  assert.strictEqual(owners[5], 1, 'L6 的 deltasink 调用归属 gamma');
  assert.strictEqual(owners[8], -1, 'epsilon 的定义行不自归属');
});

test('scopeOwners：无符号文件时全为 -1', () => {
  const owners = LayeredCodeGraph.scopeOwners(['a', 'b'], [], 120);
  assert.deepStrictEqual(owners, [-1, -1]);
});

test('层化图 vs 稠密图：稀疏化显著，且真实关联一条不丢', () => {
  const dense = CodeGraphIndex.buildCodeGraph(CORPUS);
  const layered = LayeredCodeGraph.buildLayeredCodeGraph(CORPUS);

  const denseCount = LayeredCodeGraph.edgeCountOf(dense);
  const layeredCount = LayeredCodeGraph.edgeCountOf(layered);

  // 稠密图：3 个本地符号 × 2 个外部引用 = 6 对 = 12 条有向边。
  assert.strictEqual(denseCount, 12, '稠密图为笛卡尔积');
  // 层化图：每个引用只归属一个宿主 ⇒ 2 对 = 4 条有向边。
  assert.strictEqual(layeredCount, 4, '层化图按作用域归属，稀疏 3×');
  assert.ok(layeredCount < denseCount, '层化必须比稠密更稀疏');

  // 真实关联必须保留：alpha↔betahelper、gamma↔deltasink。
  const hasEdge = (g: typeof layered, a: number, b: number): boolean =>
    (g.adj[a] ?? []).some(([j]) => j === b);
  assert.ok(hasEdge(layered, 0, 3), 'alpha → betahelper（id 3）保留');
  assert.ok(hasEdge(layered, 1, 4), 'gamma → deltasink（id 4）保留');

  // 虚假关联必须消除：epsilon 没引用任何外部符号，却不该有边。
  assert.strictEqual((layered.adj[2] ?? []).length, 0, 'epsilon 不应有出边');
  assert.ok(hasEdge(dense, 2, 3), '稠密图里 epsilon 被笛卡尔积连上了（这正是要消除的）');
});

test('层化图：确定性（同输入两次构建结果一致）', () => {
  const a = LayeredCodeGraph.buildLayeredCodeGraph(CORPUS);
  const b = LayeredCodeGraph.buildLayeredCodeGraph(CORPUS);
  assert.strictEqual(LayeredCodeGraph.edgeCountOf(a), LayeredCodeGraph.edgeCountOf(b));
  assert.deepStrictEqual(a.adj, b.adj);
});

test('layeredFileRoute：空种子返回空列表', () => {
  const g = LayeredCodeGraph.buildLayeredCodeGraph(CORPUS);
  assert.deepStrictEqual(LayeredCodeGraph.layeredFileRoute(SYMBOLS, g, new Map(), 10), []);
});

test('layeredFileRoute：种子沿边扩散到被引用文件，且结果确定', () => {
  const g = LayeredCodeGraph.buildLayeredCodeGraph(CORPUS);
  // 只给 alpha（a.ts）打种子，扩散后应把 betahelper 所在的 b.ts 带出来。
  const seed = new Map<number, number>([[0, 1]]);
  const route = LayeredCodeGraph.layeredFileRoute(SYMBOLS, g, seed, 10);
  assert.ok(route.includes('a.ts'), '种子自身文件应在列');
  assert.ok(route.includes('b.ts'), 'alpha 引用 betahelper ⇒ b.ts 应被扩散带出');
  assert.ok(!route.includes('c.ts'), 'c.ts 与本种子无边（gamma 才引用它）');

  // 确定性：同输入两次结果完全相同。
  assert.deepStrictEqual(route, LayeredCodeGraph.layeredFileRoute(SYMBOLS, g, seed, 10));
});

test('layeredFileRoute：limit 生效且按分数降序', () => {
  const g = LayeredCodeGraph.buildLayeredCodeGraph(CORPUS);
  const seed = new Map<number, number>([
    [0, 1],
    [1, 1],
  ]);
  const all = LayeredCodeGraph.layeredFileRoute(SYMBOLS, g, seed, 10);
  assert.ok(all.length >= 3);
  assert.deepStrictEqual(LayeredCodeGraph.layeredFileRoute(SYMBOLS, g, seed, 2), all.slice(0, 2));
});

test('buildLayeredCodeGraph：空语料不抛错', () => {
  const g = LayeredCodeGraph.buildLayeredCodeGraph({ symbols: [], fileText: new Map() });
  assert.strictEqual(g.n, 0);
  assert.strictEqual(LayeredCodeGraph.edgeCountOf(g), 0);
});
