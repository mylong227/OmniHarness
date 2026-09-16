/**
 * 载荷投送策略（RepoMapPayload）组件级单测 —— 「高精度导弹」的弹药分配。
 *
 * 验证五件事：
 * 1. **零行为变更**：`tiered=false` 与历史组装（`['# Repo Map...', outline, '# Relevant Symbols', ...sigLines]`）
 *    逐字相同 —— 这是评测报告口径冻结的前提。
 * 2. **文件集合不变量**：`tiered=true` 与 `tiered=false` 解析出的 `📄 路径` 集合**完全相同**
 *    （构造性保证：只改呈现，不改选中文件，故 `hitRate@K` 必然不降）。
 * 3. **梯度结构**：前 `FULL_TIER` 个文件给完整符号大纲；紧随的 `NAME_TIER` 个给「路径 + 命中符号名」；
 *    其余仅一行路径。
 * 4. **token 更省**：同文件集合下 tiered 的 token 严格少于 full。
 * 5. **确定性**：同输入两次调用逐字相同。
 *
 * 真实语料上的收益（33 条查询、K=14/20 的降幅）见 `evals/military-verdict.mjs` 与
 * `evals/military-verdict.report.json`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexCorpus } from '../../src/context/contextEngine.js';
import type { IndexedCorpus } from '../../src/context/contextEngine.js';
import { outlineText } from '../../src/context/repoMap.js';
import { RepoMapPayload } from '../../src/context/repoMapPayload.js';
import { tokenize } from '../../src/search/bm25Index.js';

/** 夹具：12 个文件，每个声明一个名字含 `alpha` / `widget` 的符号。 */
class Fixture {
  /**
   * 写一个临时工作区并索引它。
   * @param files 文件名 → 内容
   * @returns 临时目录（供 finally 清理）与已索引语料
   */
  public static build(files: Readonly<Record<string, string>>): {
    dir: string;
    corpus: IndexedCorpus;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'payload-'));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, 'utf8');
    }
    return { dir, corpus: indexCorpus(dir, { morph: true, light: true }) };
  }

  /**
   * 生成 12 个同名符号文件（便于检验三档边界）。
   * @returns 文件名 → 内容的映射
   */
  public static twelve(): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 1; i <= 12; i += 1) {
      out[`f${String(i).padStart(2, '0')}.ts`] = [
        'export function alphaWidget(): void {',
        '  return;',
        '}',
      ].join('\n');
    }
    return out;
  }
}

/**
 * 从上下文文本中抽取全部 `📄 路径` 行（去掉前缀）。
 * @param text 上下文文本
 * @returns 路径列表（保持出现次序）
 */
function docPaths(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('📄 '))
    .map((l) => l.replace(/^📄\s*/, ''));
}

/**
 * 从上下文文本中抽取符号行（3 空格缩进 + L 行号）。
 * @param text 上下文文本
 * @returns 符号行列表
 */
function outlineLines(text: string): string[] {
  return text.split('\n').filter((l) => l.startsWith('   L'));
}

test('零行为变更：tiered=false 与历史组装逐字相同', () => {
  const { dir, corpus } = Fixture.build(Fixture.twelve());
  try {
    const files = corpus.files.map((f) => f.rel);
    const symbols = corpus.symbols.slice(0, 5);
    const fileSet = new Set(files);
    const outline = outlineText(corpus.symbols.filter((s) => fileSet.has(s.file)));
    const sigLines = symbols.map((s) => `L${s.line} ${s.kind} ${s.name} @ ${s.file}`);
    const expected = [
      '# Repo Map (relevant files)',
      outline,
      '# Relevant Symbols',
      ...sigLines,
    ].join('\n');
    const actual = RepoMapPayload.assemble({ corpus, files, symbols, query: 'alpha widget' }, null);
    assert.strictEqual(actual, expected, 'full 档必须逐字复现历史组装');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文件集合不变量：tiered 与 full 的 📄 路径集合完全相同', () => {
  const { dir, corpus } = Fixture.build(Fixture.twelve());
  try {
    const files = corpus.files.map((f) => f.rel);
    const symbols = corpus.symbols.slice(0, 5);
    const full = RepoMapPayload.assemble({ corpus, files, symbols, query: 'alpha widget' }, null);
    const tiered = RepoMapPayload.assemble(
      { corpus, files, symbols, query: 'alpha widget' },
      RepoMapPayload.DEFAULT_PLAN,
    );
    assert.deepEqual(
      docPaths(tiered).sort(),
      docPaths(full).sort(),
      '只改呈现，不得改变选中文件集合',
    );
    assert.strictEqual(docPaths(tiered).length, files.length, '每个入选文件都应有一行路径');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('梯度结构：头部给完整大纲，中段给命中符号名，尾部仅路径', () => {
  const { dir, corpus } = Fixture.build(Fixture.twelve());
  try {
    const files = corpus.files.map((f) => f.rel);
    const symbols = corpus.symbols.slice(0, 5);
    const full = RepoMapPayload.assemble({ corpus, files, symbols, query: 'alpha widget' }, null);
    const tiered = RepoMapPayload.assemble(
      { corpus, files, symbols, query: 'alpha widget' },
      RepoMapPayload.DEFAULT_PLAN,
    );
    const fullSym = outlineLines(full).length;
    const tieredSym = outlineLines(tiered).length;
    assert.strictEqual(fullSym, files.length, '前置条件：full 档每文件一行符号');
    assert.strictEqual(
      tieredSym,
      RepoMapPayload.DEFAULT_PLAN.fullTier + RepoMapPayload.DEFAULT_PLAN.nameTier,
      'tiered 档符号行 = 完整档 + 命中符号名档',
    );
    // 第 4..8 档必须在「📄 路径」之后紧跟命中符号名（否则中段档退化成纯路径）。
    const idx = tiered.indexOf(`📄 ${files[RepoMapPayload.DEFAULT_PLAN.fullTier] ?? ''}`);
    assert.ok(idx > 0, '前置条件：第 4 个文件应作为路径行出现');
    const after = tiered.slice(idx).split('\n');
    assert.ok((after[1] ?? '').startsWith('   L'), '中段档的路径行之后应紧跟命中符号名行');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('token 更省：同文件集合下 tiered 严格少于 full', () => {
  const { dir, corpus } = Fixture.build(Fixture.twelve());
  try {
    const files = corpus.files.map((f) => f.rel);
    const symbols = corpus.symbols.slice(0, 5);
    const full = RepoMapPayload.assemble({ corpus, files, symbols, query: 'alpha widget' }, null);
    const tiered = RepoMapPayload.assemble(
      { corpus, files, symbols, query: 'alpha widget' },
      RepoMapPayload.DEFAULT_PLAN,
    );
    assert.ok(
      tokenize(tiered).length < tokenize(full).length,
      `tiered(${tokenize(tiered).length}) 应少于 full(${tokenize(full).length})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('确定性：同输入两次调用逐字相同', () => {
  const { dir, corpus } = Fixture.build(Fixture.twelve());
  try {
    const files = corpus.files.map((f) => f.rel);
    const symbols = corpus.symbols.slice(0, 5);
    const input = { corpus, files, symbols, query: 'alpha widget' };
    assert.strictEqual(
      RepoMapPayload.assemble(input, RepoMapPayload.DEFAULT_PLAN),
      RepoMapPayload.assemble(input, RepoMapPayload.DEFAULT_PLAN),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('应急压缩档：只留 Top-1 完整大纲，文件集合仍不变且 token 更少', () => {
  const { dir, corpus } = Fixture.build(Fixture.twelve());
  try {
    const files = corpus.files.map((f) => f.rel);
    const symbols = corpus.symbols.slice(0, 5);
    const input = { corpus, files, symbols, query: 'alpha widget' };
    const tiered = RepoMapPayload.assemble(input, RepoMapPayload.DEFAULT_PLAN);
    const degrade = RepoMapPayload.assemble(input, RepoMapPayload.DEGRADE_PLAN);
    assert.strictEqual(RepoMapPayload.DEGRADE_PLAN.fullTier, 1, '应急档只保留 Top-1 的完整大纲');
    assert.strictEqual(outlineLines(degrade).length, 1, '应急档应只有 1 行符号大纲');
    assert.deepEqual(docPaths(degrade).sort(), docPaths(tiered).sort(), '文件集合仍不变');
    assert.ok(tokenize(degrade).length < tokenize(tiered).length, '应急档 token 应少于默认梯度档');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
