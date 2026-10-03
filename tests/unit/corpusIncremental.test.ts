/**
 * repo-map 语料**增量重建**的正确性单测（2026-10-03，`docs/PROJECT_BOARD.md` §3.1 遗留项）。
 *
 * 判据只有一条，且是最强的那条：**增量结果必须与全量重建逐位一致**。
 * 语料是检索的唯一事实来源，增量路径若与全量路径有任何口径漂移（词项、符号顺序、BM25 槽位、
 * 文档长度），召回会**静默**变差且不报错——所以这里不比对「召回率」，而是直接对拍：
 *   ① `files` / `symbols` 逐字段相同；
 *   ② 两套 BM25 索引在一组查询上的命中 id 与**分数逐位相同**；
 *   ③ `fileText` 内容相同；
 *   ④ 覆盖三类改动：改文件内容、不改变符号数、符号数变化（触发符号索引整体重建）；
 *   ⑤ 无关写操作（内容没变）必须复用**同一语料对象**（否则下游 memo / 语义缓存白白失效）；
 *   ⑥ 文件集合变化（新增 / 删除）必须拒绝增量并回落到全量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { ContextEngine, type IndexedCorpus } from '../../src/context/contextEngine.js';
import { CorpusIncrementalUpdater } from '../../src/context/corpusIncrementalUpdater.js';
import { CorpusFileParser } from '../../src/context/corpusFileParser.js';
import { CorpusIndexCache } from '../../src/context/corpusIndexCache.js';
import type { CorpusFileArtifact } from '../../src/context/corpusFileArtifact.js';

/** 造一个最小工作区（`ContextEngine` 只认 .ts/.js/.py）。 */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni-incremental-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'alpha.ts'),
    'export class AlphaService {\n  run(): void {}\n}\nexport function alphaHelper(): number { return 1; }\n',
    'utf8',
  );
  writeFileSync(
    join(dir, 'src', 'beta.ts'),
    'export interface BetaOptions { readonly x: number }\nexport const betaConst = 42;\n',
    'utf8',
  );
  writeFileSync(
    join(dir, 'src', 'gamma.js'),
    'export function gammaRunner() { return 0; }\n',
    'utf8',
  );
  return dir;
}

/** 全量重建 + 产物表（模拟 `CorpusIndexCache` 的首次索引路径）。 */
function fresh(root: string): {
  corpus: IndexedCorpus;
  artifacts: Map<string, CorpusFileArtifact>;
} {
  const artifacts = new Map<string, CorpusFileArtifact>();
  const corpus = ContextEngine.indexCorpus(root, {
    morph: true,
    light: true,
    artifactSink: artifacts,
  });
  return { corpus, artifacts };
}

/** 逐文件字节哈希（与 `CorpusIndexCache` 的签名复核同口径：走 walk 拿清单，再逐文件 SHA-1 字节）。 */
function contentHashes(root: string): Map<string, string> {
  const rels: string[] = [];
  ContextEngine.walk(root, root, rels, {});
  const hashes = new Map<string, string>();
  for (const rel of rels) {
    hashes.set(
      rel,
      CorpusFileParser.hashOfBytes(readFileSync(join(root, rel.split('/').join(sep)))),
    );
  }
  return hashes;
}

/** 对拍两次语料：结构 + BM25 搜索结果逐位一致。 */
function assertSameCorpus(actual: IndexedCorpus, expected: IndexedCorpus): void {
  assert.deepStrictEqual(actual.files, expected.files, 'files（rel + token 计数）必须逐条一致');
  assert.deepStrictEqual(
    actual.symbols,
    expected.symbols,
    'symbols（顺序 / 行号 / 签名）必须逐条一致',
  );
  assert.strictEqual(actual.fileText.size, expected.fileText.size, 'fileText 条数一致');
  for (const [rel, text] of expected.fileText) {
    assert.strictEqual(actual.fileText.get(rel), text, `fileText[${rel}] 必须一致`);
  }
  const queries = ['alpha service', 'beta options', 'gammaRunner', 'alphaHelper', 'const'];
  for (const q of queries) {
    assert.deepStrictEqual(
      actual.symbolIndex.search([...new Set(q.split(/\s+/))], 5),
      expected.symbolIndex.search([...new Set(q.split(/\s+/))], 5),
      `符号索引在查询「${q}」上必须逐位一致`,
    );
    assert.deepStrictEqual(
      actual.fileIndex.search([...new Set(q.split(/\s+/))], 5),
      expected.fileIndex.search([...new Set(q.split(/\s+/))], 5),
      `文件索引在查询「${q}」上必须逐位一致`,
    );
  }
}

test('① 改文件内容（符号数不变）：增量与全量逐位一致', () => {
  const root = workspace();
  try {
    const first = fresh(root);
    writeFileSync(
      join(root, 'src', 'alpha.ts'),
      'export class AlphaService {\n  run(): void { /* 改过的实现 */ }\n}\nexport function alphaHelper(): number { return 2; }\n',
      'utf8',
    );
    const updated = new CorpusIncrementalUpdater({ morph: true, light: true }).update(
      root,
      first.corpus,
      first.artifacts,
      contentHashes(root),
    );
    assert.notStrictEqual(updated, null, '文件集未变 ⇒ 必须能增量');
    assert.strictEqual(updated?.reparsed, 1, '只有 alpha.ts 需要重新解析');
    assertSameCorpus(updated!.corpus, fresh(root).corpus);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('② 符号数变化（新增函数）：增量仍与全量逐位一致（走符号索引整体重建）', () => {
  const root = workspace();
  try {
    const first = fresh(root);
    writeFileSync(
      join(root, 'src', 'beta.ts'),
      'export interface BetaOptions { readonly x: number }\nexport const betaConst = 42;\nexport function betaNew(): void {}\nexport function betaExtra(): void {}\n',
      'utf8',
    );
    const updated = new CorpusIncrementalUpdater({ morph: true, light: true }).update(
      root,
      first.corpus,
      first.artifacts,
      contentHashes(root),
    );
    assert.notStrictEqual(updated, null);
    assertSameCorpus(updated!.corpus, fresh(root).corpus);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('③ 内容没变：复用**同一语料对象**（身份不变 ⇒ 下游 memo / 语义缓存不必失效）', () => {
  const root = workspace();
  try {
    const first = fresh(root);
    const updated = new CorpusIncrementalUpdater({ morph: true, light: true }).update(
      root,
      first.corpus,
      first.artifacts,
      contentHashes(root),
    );
    assert.strictEqual(updated?.reparsed, 0);
    assert.strictEqual(updated?.corpus, first.corpus, '无变化必须原样返回旧对象');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('④ 文件集合变化（新增 / 删除）：拒绝增量并回落全量', () => {
  const root = workspace();
  try {
    const first = fresh(root);
    const updater = new CorpusIncrementalUpdater({ morph: true, light: true });
    writeFileSync(join(root, 'src', 'delta.ts'), 'export function delta(): void {}\n', 'utf8');
    assert.strictEqual(
      updater.update(root, first.corpus, first.artifacts, contentHashes(root)),
      null,
      '新增文件必须回落全量（文件槽位整体重排）',
    );
    rmSync(join(root, 'src', 'delta.ts'), { force: true });
    const second = fresh(root);
    rmSync(join(root, 'src', 'gamma.js'), { force: true });
    assert.strictEqual(
      updater.update(root, second.corpus, second.artifacts, contentHashes(root)),
      null,
      '删除文件必须回落全量',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⑤ 缺产物表 / full 模式：拒绝增量（宁可慢不可错）', () => {
  const root = workspace();
  try {
    const first = fresh(root);
    const hashes = contentHashes(root);
    assert.strictEqual(
      new CorpusIncrementalUpdater({ morph: true, light: true }).update(
        root,
        first.corpus,
        undefined,
        hashes,
      ),
      null,
      '缺产物表 ⇒ 逐文件 setDocument 与全量同阶，没有收益故拒绝',
    );
    assert.strictEqual(
      new CorpusIncrementalUpdater({ morph: true, light: false }).update(
        root,
        first.corpus,
        first.artifacts,
        hashes,
      ),
      null,
      'full 模式与符号下标强耦合，不做增量',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⑥ 缓存层端到端：写文件后取语料走增量，且结果与全量一致', () => {
  const root = workspace();
  const previous = process.env['OMNI_REPO_MAP_TTL_MS'];
  process.env['OMNI_REPO_MAP_TTL_MS'] = '0';
  try {
    const cache = new CorpusIndexCache();
    const first = cache.get(root);
    assert.notStrictEqual(first, null);
    writeFileSync(
      join(root, 'src', 'gamma.js'),
      'export function gammaRunner() { return 7; }\nexport function gammaExtra() { return 8; }\n',
      'utf8',
    );
    const second = cache.get(root);
    assert.notStrictEqual(second, null);
    assertSameCorpus(second!, fresh(root).corpus);
    // 内容未再变 ⇒ 再一次取用必须命中同一对象（增量把无变化情形收敛为身份不变）。
    assert.strictEqual(cache.get(root), second);
  } finally {
    if (previous === undefined) delete process.env['OMNI_REPO_MAP_TTL_MS'];
    else process.env['OMNI_REPO_MAP_TTL_MS'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
