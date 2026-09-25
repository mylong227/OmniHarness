/**
 * P5 图信号第四路单测：稀疏引用图构建 + PageRank 中心性 + 查询邻域路由。
 * 纯函数、零模型、确定性，验证「稀疏化过滤」与「邻域不含 seed 自身文件」两个不变量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeReferenceGraph, MAX_CACHED_ROOTS } from '../../src/context/codeReferenceGraph.js';
import type { IndexedCorpus } from '../../src/context/contextEngine.js';

// 最小合成语料：3 文件、3 符号，其中 registerTool / execPolicy 互为罕见共享引用，
// config 属噪声名（不参与罕见互引）不应连边。
const symbols = [
  {
    file: 'a.ts',
    line: 1,
    kind: 'function',
    name: 'registerTool',
    signature: 'function registerTool()',
  },
  { file: 'b.ts', line: 1, kind: 'const', name: 'execPolicy', signature: 'const execPolicy' },
  { file: 'c.ts', line: 1, kind: 'const', name: 'config', signature: 'const config' },
];
const fileText = new Map([
  // a.ts 用到 execPolicy（指向 b.ts 的罕见符号）→ 应连边
  ['a.ts', 'function registerTool() { const x = execPolicy; }'],
  // b.ts 用到 registerTool（指向 a.ts 的罕见符号）→ 应连边
  ['b.ts', 'const execPolicy = registerTool;'],
  // c.ts 只用 config（噪声名）→ 不连边
  ['c.ts', 'const config = 1;'],
]);

function makeCorpus(): IndexedCorpus {
  // getGraphSignal 仅读取 symbols / fileText，其余字段用最小占位即可。
  return {
    root: 'fake',
    morph: true,
    symbols,
    files: [],
    symbolIndex: {},
    fileIndex: {},
    symbolSpectra: [],
    fileText,
    codeGraph: { n: 0, adj: [] },
    lsaModel: {},
  } as unknown as IndexedCorpus;
}

test('稀疏引用图只保留罕见共享标识符边，稠密噪声边被过滤', () => {
  CodeReferenceGraph.clearGraphSignal('fake');
  const sig = CodeReferenceGraph.getGraphSignal('fake', makeCorpus());
  // a.ts ↔ b.ts 因罕见符号互引连边；config 是噪声名 → 无 c.ts 相关边。
  // 图节点数 = 符号数 = 3；边来自 a↔b（双向各 1）。
  assert.ok(sig.edgeCount >= 2, `应至少有 a↔b 两条边，实际 ${sig.edgeCount}`);
  // 中心性归一化到 [0,1]，且每个被连文件都有值。
  for (const v of sig.fileCentrality.values()) {
    assert.ok(v >= 0 && v <= 1, `中心性应 ∈[0,1]，实际 ${v}`);
  }
  assert.ok(sig.fileCentrality.has('a.ts') && sig.fileCentrality.has('b.ts'));
});

test('查询邻域第四路只返回邻居文件，不含 seed 自身文件', () => {
  CodeReferenceGraph.clearGraphSignal('fake');
  const sig = CodeReferenceGraph.getGraphSignal('fake', makeCorpus());
  // seed = registerTool（符号下标 0，属 a.ts）→ 1 跳邻居应到 b.ts（execPolicy），不含 a.ts。
  const route = CodeReferenceGraph.graphNeighborFileRoute(makeCorpus(), [0], sig);
  // 路由里不应含 seed 自身文件 a.ts。
  assert.ok(!route.includes('file:a.ts'), '邻域路由不应包含 seed 自身文件');
  assert.ok(route.includes('file:b.ts'), '应沿引用边召回邻居文件 b.ts');
});

test('seed 为空时邻域路由返回空列表（fail-closed 友好，不抛不崩）', () => {
  CodeReferenceGraph.clearGraphSignal('fake');
  const sig = CodeReferenceGraph.getGraphSignal('fake', makeCorpus());
  const route = CodeReferenceGraph.graphNeighborFileRoute(makeCorpus(), [], sig);
  assert.deepStrictEqual(route, []);
});

test('同 root 图信号按缓存复用，不重复构建', () => {
  CodeReferenceGraph.clearGraphSignal('fake');
  const sig1 = CodeReferenceGraph.getGraphSignal('fake', makeCorpus());
  const sig2 = CodeReferenceGraph.getGraphSignal('fake', makeCorpus());
  assert.strictEqual(sig1, sig2, '同 root 应返回同一缓存实例');
});

test('图信号缓存有界：超过 MAX_CACHED_ROOTS 时按插入序淘汰最旧（进程级 Map 不得无界增长）', () => {
  CodeReferenceGraph.clearGraphSignal();
  const first = CodeReferenceGraph.getGraphSignal('root-0', makeCorpus());
  for (let i = 1; i <= MAX_CACHED_ROOTS; i += 1) {
    CodeReferenceGraph.getGraphSignal(`root-${String(i)}`, makeCorpus());
  }
  const rebuilt = CodeReferenceGraph.getGraphSignal('root-0', makeCorpus());
  assert.notStrictEqual(
    rebuilt,
    first,
    `超上限后 root-0 应被淘汰并重建（上限 ${String(MAX_CACHED_ROOTS)}）`,
  );
  CodeReferenceGraph.clearGraphSignal();
});
