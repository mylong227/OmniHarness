import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getRepoMapContext,
  getHybridRepoMapContext,
  clearRepoMapCache,
  buildChunkItems,
} from '../../src/context/repoMapContext.js';
import type { IndexedCorpus } from '../../src/context/contextEngine.js';
import type { Embedding, EmbeddingPort } from '../../src/ports/embedding.js';

/** 确定性伪嵌入：向量 = 各字符落桶计数。无需真实模型，足以驱动混合检索机制且不崩。 */
class FakeEmbedding implements EmbeddingPort {
  public readonly dim = 4;
  public async embed(texts: readonly string[]): Promise<readonly Embedding[]> {
    return texts.map((t) => {
      const v = [0, 0, 0, 0];
      for (const ch of t) {
        const i = ch.charCodeAt(0) % 4;
        v[i] = (v[i] ?? 0) + 1;
      }
      return v;
    });
  }
}

/** 故意抛错的嵌入（模型缺失/离线场景）：混合检索必须 fail-closed 回退 BM25。 */
class ThrowingEmbedding implements EmbeddingPort {
  public readonly dim = 4;
  public async embed(): Promise<readonly Embedding[]> {
    throw new Error('model missing');
  }
}

/** 第二套确定性伪嵌入（落桶口径不同）：用于证明 semWeight=0 时输出与嵌入内容无关。 */
class FakeEmbeddingAlt implements EmbeddingPort {
  public readonly dim = 4;
  public async embed(texts: readonly string[]): Promise<readonly Embedding[]> {
    return texts.map((t) => {
      const v = [0, 0, 0, 0];
      for (const ch of t) {
        const i = (ch.charCodeAt(0) + 1) % 4; // 与 FakeEmbedding 错开，向量完全不同
        v[i] = (v[i] ?? 0) + 2;
      }
      return v;
    });
  }
}

function tmpRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'omniharness-hybrid-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  return root;
}

test('buildChunkItems：按符号切函数体窗口，chunk 数=符号数、id 正确、body 不越界', () => {
  const corpus = {
    root: '/x',
    morph: true,
    symbols: [
      { name: 'foo', kind: 'function', signature: 'foo(): void', file: 'a.ts', line: 1 },
      { name: 'bar', kind: 'function', signature: 'bar(): void', file: 'a.ts', line: 4 },
      { name: 'Baz', kind: 'class', signature: 'class Baz', file: 'b.ts', line: 2 },
    ],
    files: [],
    symbolIndex: {},
    fileIndex: {},
    symbolSpectra: [],
    codeGraph: {},
    lsaModel: {},
    fileText: new Map<string, string>([
      [
        'a.ts',
        [
          'export function foo() {',
          "  return 'first';",
          '}',
          '',
          'export function bar() {',
          "  return 'second';",
          '}',
        ].join('\n'),
      ],
      ['b.ts', ['class Baz {', '  method() {}', '}'].join('\n')],
    ]),
  } as unknown as IndexedCorpus;

  const items = buildChunkItems(corpus);
  assert.strictEqual(items.length, 3, 'chunk 数应等于符号数');
  assert.deepStrictEqual(
    items.map((i) => i.id),
    ['chunk:0', 'chunk:1', 'chunk:2'],
  );
  // foo 在 a.ts 第 1 行，bar 在第 4 行 → foo 的 body 窗口应覆盖第 1~3 行（到 bar 之前）
  assert.match(items[0]!.text, /foo\(\): void/, 'chunk 文本应含符号签名');
  assert.match(items[0]!.text, /first/, 'foo chunk 应含自身函数体');
  assert.doesNotMatch(items[0]!.text, /second/, 'foo chunk 不应越界含 bar 的函数体');
  // bar 是 a.ts 末尾符号 → 取固定尾部窗口，含自身函数体
  assert.match(items[1]!.text, /second/, 'bar chunk 应含自身函数体');
  // Baz 单独在 b.ts
  assert.match(items[2]!.text, /method\(\)/, 'Baz chunk 应含其方法体');
});

/**
 * 「标识只藏在函数体深处」的语料：deep.ts 正文前 600 字符全是无信息量填充，
 * 标识（200 个 z）只出现在函数体里；crowd 文件的正文里放 100 个 y（语义次相关）。
 *
 * 关键设计（踩过坑，勿简化）：查询必须是**词法上不存在、但字符分布上贴近**的字符串
 * —— 即 `'z'×200 + 'y'×80` 直接拼成一个 280 字符的 token。
 *  - BM25 的文件索引覆盖**文件全文**，若查询就用 `'z'×200`，它会直接词法命中 deep.ts，
 *    语义路根本没被隔离出来，「关 chunk 就漏召」就成了假命题（第一版正是这么翻车的）。
 *  - 拼上 y 后该 token 在任何文件中都不存在 → BM25 零命中，只剩语义路可判。
 */
function deepBodyRepo(): { root: string; query: string } {
  const filler = `// ${'x'.repeat(700)}\n`;
  const marker = 'z'.repeat(200);
  // 函数必须写成**多行**：符号抽取器按行取 signature，单行声明会把整行（含函数体）吃进 signature，
  // 于是「符号文档」里就已经带了标识 → 不开分块也能命中，对照失效（诊断踩坑记录）。
  const files: Record<string, string> = {};
  for (let i = 0; i < 20; i++) {
    files[`crowd${i}.ts`] = `export function gen${i}() {\n  return '${'y'.repeat(100)}';\n}\n`;
  }
  // 三个函数体各带一份 marker：命中后映射到同一文件，RRF 内累加三路贡献，
  // 使「分块前后的差异」远大于排序抖动，断言稳定。
  files['deep.ts'] =
    filler +
    `export function helperA() {\n  return '${marker}';\n}\n` +
    `export function helperB() {\n  return '${marker}';\n}\n` +
    `export function helperC() {\n  return '${marker}';\n}\n`;
  return { root: tmpRepo(files), query: `${'z'.repeat(200)}${'y'.repeat(80)}` };
}

/**
 * 轴对齐的确定性伪嵌入：向量 = 归一化的 (z 计数, y 计数)。
 * 查询含 200 z + 80 y → [0.93, 0.37]；deep.ts 的 chunk 含 200 z → [1,0]（点积 0.93，最高）；
 * crowd 文件文档含 100 y → [0,1]（点积 0.37，次之）；无 z/y 的项 → [0,0]（点积 0，垫底）。
 * 语义只认字符分布、BM25 只认 token，两路由此彻底隔离。
 */
class AxisEmbedding implements EmbeddingPort {
  public readonly dim = 2;
  public async embed(texts: readonly string[]): Promise<readonly Embedding[]> {
    return texts.map((t) => {
      let z = 0;
      let y = 0;
      for (const ch of t) {
        if (ch === 'z') z++;
        else if (ch === 'y') y++;
      }
      const n = Math.hypot(z, y);
      return n === 0 ? [0, 0] : [z / n, y / n];
    });
  }
}

test('getHybridRepoMapContext：chunkRecall 让「标识只藏在函数体深处」的文件被命中（关则漏召）', async () => {
  const { root, query } = deepBodyRepo();
  try {
    const on = await getHybridRepoMapContext(root, query, new AxisEmbedding(), {
      chunkRecall: true,
      fileK: 5,
    });
    assert.ok(
      on !== null && on.includes('deep.ts'),
      'chunkRecall=true 应经函数体 chunk 把 deep.ts 顶进结果',
    );
    const off = await getHybridRepoMapContext(root, query, new AxisEmbedding(), {
      chunkRecall: false,
      fileK: 5,
    });
    assert.ok(off !== null, 'chunkRecall=false 仍应返回非空上下文（fail-closed 不崩）');
    assert.ok(
      !off.includes('deep.ts'),
      'chunkRecall=false 时标识只藏在函数体里（文件文档仅前 600 字符），应漏召 —— 证明增益确来自分块',
    );
  } finally {
    clearRepoMapCache(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('语义索引缓存键含 chunkRecall：同进程内先关后开不得复用对方索引（脏读回归）', async () => {
  const { root, query } = deepBodyRepo();
  try {
    // ① 先用 chunk=false 构建并缓存索引（键 nochunk|root）
    const off = await getHybridRepoMapContext(root, query, new AxisEmbedding(), {
      chunkRecall: false,
      fileK: 5,
    });
    assert.ok(off !== null && !off.includes('deep.ts'), '前置条件：关时漏召');
    // ② 再以 chunk=true 调用：若缓存键只含 root，这里会命中上一步的 nochunk 索引
    //    → 仍然漏召 → 静默脏读（本测试正是为此回归而设）。
    const on = await getHybridRepoMapContext(root, query, new AxisEmbedding(), {
      chunkRecall: true,
      fileK: 5,
    });
    assert.ok(
      on !== null && on.includes('deep.ts'),
      '开启后必须重建含 chunk 的索引，不能复用 nochunk 索引（缓存键须带开关）',
    );
  } finally {
    clearRepoMapCache(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('getRepoMapContext 返回非空 repo-map（真实查询命中）', () => {
  const root = mkdtempSync(join(tmpdir(), 'omniharness-repomap-'));
  try {
    writeFileSync(
      join(root, 'a.ts'),
      'export class SandboxPolicyEvaluator {\n  evaluate() { return true; }\n}\n',
    );
    writeFileSync(join(root, 'b.ts'), 'export function computeResonance() { return 0; }\n');
    const ctx = getRepoMapContext(root, 'sandbox policy evaluate');
    assert.ok(ctx !== null, '期望非空 repo-map');
    assert.match(ctx!, /# Repo Map/);
    clearRepoMapCache(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getRepoMapContext 在 enabled:false 时返回 null', () => {
  const root = mkdtempSync(join(tmpdir(), 'omniharness-repomap-'));
  try {
    writeFileSync(join(root, 'a.ts'), 'export class Foo {}\n');
    const ctx = getRepoMapContext(root, 'foo', { enabled: false });
    assert.strictEqual(ctx, null);
    clearRepoMapCache(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getRepoMapContext 在空查询 / 坏路径 / 空根 时一律返回 null（fail-closed）', () => {
  assert.strictEqual(getRepoMapContext('/nonexistent-xyz-123', 'foo'), null);
  assert.strictEqual(getRepoMapContext(process.cwd(), '   '), null);
  assert.strictEqual(getRepoMapContext('', 'foo'), null);
});

// U4：写类工具执行后主动失效缓存的核心机制验证。
// StepRunner.maybeInvalidateRepoMap 在 write_file/apply_patch 等成功后调用的就是 clearRepoMapCache，
// 本测试直接验证「不清会陈旧、清了立即纳入新文件」这一不变量。
test('U4 不变量：写文件后不清缓存会陈旧，clearRepoMapCache 后新文件被纳入索引', () => {
  const root = mkdtempSync(join(tmpdir(), 'omniharness-repomap-u4-'));
  try {
    writeFileSync(join(root, 'apple.ts'), 'export class Apple {\n  bite() { return 1; }\n}\n');
    // 首次索引（仅含 apple.ts）
    const first = getRepoMapContext(root, 'Apple');
    assert.ok(first !== null, '首次查询应非空');
    assert.match(first!, /Apple/);

    // 中途写入新文件 banana.ts（模拟 write_file 执行成功）
    writeFileSync(join(root, 'banana.ts'), 'export class Banana {\n  peel() { return 2; }\n}\n');

    // TTL 内、未失效：仍命中旧缓存，Banana 不应出现（证明陈旧窗口确实存在）
    const stale = getRepoMapContext(root, 'Banana');
    assert.ok(stale !== null, 'stale 查询仍返回（缓存命中）');
    assert.doesNotMatch(stale!, /Banana/, '未失效时旧缓存不含新文件 Banana');

    // 模拟 StepRunner 在写类工具成功后调用 clearRepoMapCache
    clearRepoMapCache(root);

    // 失效后重新索引：Banana 应被纳入
    const fresh = getRepoMapContext(root, 'Banana');
    assert.ok(fresh !== null, '失效后查询应非空');
    assert.match(fresh!, /Banana/, '失效后新文件 Banana 应被纳入索引');

    clearRepoMapCache(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('U4 不变量：clearRepoMapCache() 无参清空全部工作区缓存且不抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'omniharness-repomap-u4b-'));
  try {
    writeFileSync(join(root, 'a.ts'), 'export class Foo {}\n');
    assert.ok(getRepoMapContext(root, 'Foo') !== null);
    assert.doesNotThrow(() => clearRepoMapCache());
    clearRepoMapCache(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── U3 混合检索（语义召回接入 repo-map）回归 ──────────────────────────────────

test('getHybridRepoMapContext：传入 EmbeddingPort 时返回非空混合上下文且含 BM25 命中符号', async () => {
  const root = tmpRepo({
    'a.ts': 'export class SandboxPolicyEvaluator {\n  evaluate() { return true; }\n}\n',
    'b.ts': 'export function computeResonance() { return 0; }\n',
  });
  try {
    const ctx = await getHybridRepoMapContext(root, 'sandbox policy evaluate', new FakeEmbedding());
    assert.ok(ctx !== null, '混合检索应返回非空上下文');
    assert.match(ctx!, /# Repo Map/);
    // RRF 包含 BM25 命中，故词法命中的符号必在结果中（召回只增不减）。
    assert.match(ctx!, /SandboxPolicyEvaluator/);
    clearRepoMapCache(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getHybridRepoMapContext：嵌入抛错时 fail-closed 回退纯 BM25（仍含词法命中符号）', async () => {
  const root = tmpRepo({
    'a.ts': 'export class SandboxPolicyEvaluator {\n  evaluate() { return true; }\n}\n',
    'b.ts': 'export function computeResonance() { return 0; }\n',
  });
  try {
    const ctx = await getHybridRepoMapContext(
      root,
      'sandbox policy evaluate',
      new ThrowingEmbedding(),
    );
    assert.ok(ctx !== null, '嵌入失败应回退 BM25 而非返回 null');
    assert.match(ctx!, /SandboxPolicyEvaluator/, '回退路径仍应含 BM25 命中符号');
    clearRepoMapCache(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getHybridRepoMapContext：空查询 / 空根 一律返回 null（fail-closed）', async () => {
  assert.strictEqual(await getHybridRepoMapContext('', 'foo', new FakeEmbedding()), null);
  assert.strictEqual(
    await getHybridRepoMapContext(process.cwd(), '   ', new FakeEmbedding()),
    null,
  );
});

// ── RRF 调参旋钮（真实代码库扫描：semWeight 是主杠杆，k 次要） ───────────────────

test('getHybridRepoMapContext：semWeight=0 切断语义嵌入路（输出与嵌入内容无关），放大后改变排序（旋钮已接线）', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 12; i++) {
    files[`f${i}.ts`] = `export function handler${i}() { return ${i}; }\n`;
  }
  const root = tmpRepo(files);
  try {
    const q = 'export function handler';
    // semWeight=0 → 嵌入路权重恒 0 → 输出只取决于 BM25，与嵌入向量内容无关。
    const dampedA = await getHybridRepoMapContext(root, q, new FakeEmbedding(), {
      semWeight: 0,
    });
    const dampedB = await getHybridRepoMapContext(root, q, new FakeEmbeddingAlt(), {
      semWeight: 0,
    });
    assert.strictEqual(
      dampedA,
      dampedB,
      'semWeight=0 时输出应与嵌入向量内容无关（嵌入路已被切断）',
    );
    // 语义路权重放大 → 融合分由语义排名主导 → 输出必然不同（证明旋钮真的进了融合）。
    const amplified = await getHybridRepoMapContext(root, q, new FakeEmbedding(), {
      semWeight: 1000,
    });
    assert.notStrictEqual(amplified, dampedA, 'semWeight 放大后语义路应改变融合结果');
  } finally {
    clearRepoMapCache(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('getHybridRepoMapContext：bm25Floor 把 BM25 头部文件钉进结果（语义主导时也不丢、且不破预算）', async () => {
  const root = tmpRepo({
    'alpha.ts': 'export function alphaHandler() { return 1; }\n',
    'beta.ts': 'export function betaHandler() { return 2; }\n',
    'gamma.ts': 'export function gammaHandler() { return 3; }\n',
    'delta.ts': 'export function deltaHandler() { return 4; }\n',
    'epsilon.ts': 'export function epsilonHandler() { return 5; }\n',
  });
  const parseFiles = (ctx: string | null): string[] => {
    if (!ctx) return [];
    const out: string[] = [];
    for (const line of ctx.split('\n')) {
      const m = line.match(/📄\s+(.+)/);
      if (m) out.push((m[1] ?? '').trim());
    }
    return out;
  };
  try {
    const q = 'handler';
    // 先取 BM25 基线（顺带建索引缓存），取头部 3 个文件作为「保护目标」。
    const bm25Head = parseFiles(getRepoMapContext(root, q)).slice(0, 3);
    assert.ok(bm25Head.length >= 3, 'BM25 基线应至少给出 3 个文件');

    // 语义路放大到极致（semWeight=1000）：正常情况下语义排名会稀释 BM25 头部命中。
    const guarded = await getHybridRepoMapContext(root, q, new FakeEmbedding(), {
      semWeight: 1000,
      bm25Floor: 3,
    });
    for (const rel of bm25Head) {
      assert.ok(
        parseFiles(guarded).includes(rel),
        `bm25Floor=3 应把 BM25 头部文件 ${rel} 钉进结果（即使语义主导）`,
      );
    }
    // 结构正确性：保护位不得突破 fileK 预算（默认 10）。
    assert.ok(parseFiles(guarded).length <= 10, 'bm25Floor 不得突破 fileK 预算');
  } finally {
    clearRepoMapCache(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('getHybridRepoMapContext：OMNI_RRF_K / OMNI_SEM_WEIGHT 非法取值回落默认（不产生 NaN 排序）', async () => {
  const root = tmpRepo({
    'a.ts': 'export class SandboxPolicyEvaluator {\n  evaluate() { return true; }\n}\n',
    'b.ts': 'export function computeResonance() { return 0; }\n',
  });
  const savedK = process.env['OMNI_RRF_K'];
  const savedW = process.env['OMNI_SEM_WEIGHT'];
  process.env['OMNI_RRF_K'] = 'not-a-number';
  process.env['OMNI_SEM_WEIGHT'] = '';
  try {
    const ctx = await getHybridRepoMapContext(root, 'sandbox policy evaluate', new FakeEmbedding());
    assert.ok(ctx !== null, '非法 env 不得导致 fail-closed 返回 null');
    assert.match(ctx, /SandboxPolicyEvaluator/, '非法 env 应回落默认值并保留 BM25 命中');
    assert.doesNotMatch(ctx, /NaN/, 'NaN 不得泄漏进上下文');
  } finally {
    if (savedK === undefined) delete process.env['OMNI_RRF_K'];
    else process.env['OMNI_RRF_K'] = savedK;
    if (savedW === undefined) delete process.env['OMNI_SEM_WEIGHT'];
    else process.env['OMNI_SEM_WEIGHT'] = savedW;
    clearRepoMapCache(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('getHybridRepoMapContext：mergeSymbols 旋钮已接线（符号命中可经 RRF 把文件顶入结果）', async () => {
  // 拥挤语料：多文件共享通用符号，仅 target.ts 含唯一符号 uniqueSymbolZ。
  const files: Record<string, string> = {};
  for (let i = 0; i < 14; i++) files[`crowd${i}.ts`] = 'export function gen() { return 0; }\n';
  files['target.ts'] = 'export function uniqueSymbolZ() { return 0; }\n';
  const root = tmpRepo(files);
  try {
    const q = 'uniqueSymbolZ';
    const on = await getHybridRepoMapContext(root, q, new FakeEmbedding(), { mergeSymbols: true });
    assert.ok(
      on !== null && on.includes('target.ts'),
      'mergeSymbols=true 应经符号命中把 target.ts 拉入结果',
    );
    // 关闭后仍是合法结果（不崩、不丢 fail-closed）。
    const off = await getHybridRepoMapContext(root, q, new FakeEmbedding(), {
      mergeSymbols: false,
    });
    assert.ok(off !== null, 'mergeSymbols=false 仍应返回非空上下文');
  } finally {
    clearRepoMapCache(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('getHybridRepoMapContext：mergeSymbols=true 且嵌入抛错仍 fail-closed 回退纯 BM25', async () => {
  const root = tmpRepo({
    'win.ts': 'export function uniqueSymbolZ() { return 1; }\n',
    'x.ts': 'export function otherA() { return 2; }\n',
  });
  try {
    const fail = await getHybridRepoMapContext(root, 'uniqueSymbolZ', new ThrowingEmbedding(), {
      mergeSymbols: true,
    });
    assert.strictEqual(
      fail,
      getRepoMapContext(root, 'uniqueSymbolZ'),
      'merge 代码路径也必须 fail-closed（不能绕过 try/catch）',
    );
  } finally {
    clearRepoMapCache(root);
    rmSync(root, { recursive: true, force: true });
  }
});
