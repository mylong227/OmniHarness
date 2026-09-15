/**
 * 重排索引（FileRerankIndex）组件级单测。
 *
 * 验证三件事：
 * 1. **词集口径与检索侧一致**：符号名走 camelCase 拆分 + 词形归并（`morph` 口径跟随语料），
 *    否则重排看到的词与第一段索引的词不相交，覆盖率恒为 0（静默失效）。
 * 2. **IDF 与第一段同源**：`idf` 必须复用 `Bm25Index.idf`（稀有词高于常见词、未收录为 0），
 *    `weight` 对未收录词退化为极小正权重而非 0（避免分母为 0 或权重失衡）。
 * 3. **缓存语义**：同一语料同一文件重复取词集返回**同一实例**（惰性缓存真的生效）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexCorpus } from '../../src/context/contextEngine.js';
import { FileRerankIndex } from '../../src/context/fileRerankIndex.js';
import { ContentStopWords } from '../../src/context/contentStopWords.js';

/** 夹具：把「文件内容 → 临时语料」的搭建收口，避免各用例重复写盘逻辑。 */
class Fixture {
  /**
   * 写一个临时工作区并索引它。
   * @param files 文件名 → 内容
   * @param morph 是否启用词形归并（默认 true，与生产一致）
   * @returns 临时目录（供 finally 清理）与已索引语料
   */
  public static build(
    files: Readonly<Record<string, string>>,
    morph = true,
  ): { dir: string; corpus: ReturnType<typeof indexCorpus> } {
    const dir = mkdtempSync(join(tmpdir(), 'rerank-'));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, 'utf8');
    }
    return { dir, corpus: indexCorpus(dir, { morph, light: true }) };
  }
}

/** 声明 `registerTool` 的文件（符号名可被拆成 register / tool）。 */
const REGISTRY_TS = [
  'export function registerTool(name: string): void {',
  '  void name;',
  '}',
].join('\n');

/** 只在注释里提到 registry 的文件（符号名不含 register / tool）。 */
const DOC_TS = [
  '// hub module: mentions registry prose only',
  'export function hub(): number {',
  '  return 1;',
  '}',
].join('\n');

test('nameTerms：符号名走 camelCase 拆分 + 词形归并（与检索侧同口径）', () => {
  const { dir, corpus } = Fixture.build({ 'registry.ts': REGISTRY_TS, 'doc.ts': DOC_TS });
  try {
    const index = new FileRerankIndex();
    const terms = index.nameTerms(corpus, 'registry.ts');
    assert.ok(terms.has('register'), 'registerTool 应被拆出 register');
    assert.ok(terms.has('tool'), 'registerTool 应被拆出 tool');
    // 归并产物（register → regist）也应存在，否则重排与查询侧 registration 不相交。
    assert.ok(terms.has('regist'), 'register 应归并出 regist');
    // 只提注释的文件的符号名词集不含这些词。
    const docTerms = index.nameTerms(corpus, 'doc.ts');
    assert.equal(docTerms.has('register'), false);
    assert.equal(docTerms.has('tool'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nameTerms：morph=false 时退化为基础分词（不拆分 camelCase）', () => {
  const { dir, corpus } = Fixture.build({ 'registry.ts': REGISTRY_TS }, false);
  try {
    const terms = new FileRerankIndex().nameTerms(corpus, 'registry.ts');
    assert.ok(terms.has('registertool'), '基础分词保留整词小写');
    assert.equal(terms.has('tool'), false, '不拆分则不应出现子词');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nameTerms：文件不存在声明符号时返回空集（不抛错）', () => {
  const { dir, corpus } = Fixture.build({ 'registry.ts': REGISTRY_TS });
  try {
    const terms = new FileRerankIndex().nameTerms(corpus, 'no-such-file.ts');
    assert.equal(terms.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('contentTerms：去停用词、去短词、去重且保序', () => {
  const { dir, corpus } = Fixture.build({ 'registry.ts': REGISTRY_TS });
  try {
    const terms = new FileRerankIndex().contentTerms(corpus, 'where is the tool and the tool');
    assert.ok(terms.includes('tool'));
    for (const stop of ['where', 'is', 'the', 'and']) {
      assert.equal(terms.includes(stop), false, `${stop} 应为停用词`);
    }
    assert.equal(terms.filter((t) => t === 'tool').length, 1, '内容词应去重');
    // 短词（< 3 字符）不进内容词。
    assert.equal(terms.includes('a'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('idf：与 Bm25Index 同源——稀有词高于常见词、未收录为 0', () => {
  const { dir, corpus } = Fixture.build({ 'registry.ts': REGISTRY_TS, 'doc.ts': DOC_TS });
  try {
    const index = new FileRerankIndex();
    // 口径说明：**文件级**索引的正文走基础分词（不拆 camelCase、不做词形归并），
    // 所以能拿到的 df 来自「字面词 + 路径词」——'hub' 只在 doc.ts 出现（df=1），
    // 'registry' 既是 registry.ts 的路径词、也出现在 doc.ts 正文里（df=2）。
    const rare = index.idf(corpus, 'hub');
    const common = index.idf(corpus, 'registry');
    const absent = index.idf(corpus, 'zzz-not-in-corpus');
    assert.equal(absent, 0);
    assert.ok(rare > 0 && common > 0);
    assert.ok(rare > common, `稀有词 IDF 应更高：hub=${rare} registry=${common}`);
    // 与索引本体完全一致（同源，非第二套公式）。
    assert.equal(rare, corpus.fileIndex.idf('hub'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('weight：未收录词退化为极小正权重（不返回 0）', () => {
  const { dir, corpus } = Fixture.build({ 'registry.ts': REGISTRY_TS, 'doc.ts': DOC_TS });
  try {
    const index = new FileRerankIndex();
    const w = index.weight(corpus, 'zzz-not-in-corpus');
    assert.ok(w > 0, '权重必须严格为正，否则覆盖率分母可能为 0');
    assert.ok(w < 0.5, '退化权重应远小于正常 IDF');
    assert.equal(index.weight(corpus, 'hub'), corpus.fileIndex.idf('hub'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('缓存语义：同语料同文件重复取词集返回同一实例', () => {
  const { dir, corpus } = Fixture.build({ 'registry.ts': REGISTRY_TS });
  try {
    const index = new FileRerankIndex();
    assert.equal(index.nameTerms(corpus, 'registry.ts'), index.nameTerms(corpus, 'registry.ts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ContentStopWords：isContent 同时管停用词与短词', () => {
  assert.equal(ContentStopWords.isContent('tool'), true);
  assert.equal(ContentStopWords.isContent('the'), false);
  assert.equal(ContentStopWords.isContent('is'), false);
  assert.equal(ContentStopWords.isContent('ab'), false, '两字符不算内容词');
  assert.equal(ContentStopWords.has('where'), true);
});
