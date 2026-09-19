/**
 * ContextEngine 语料遍历的**内存边界**契约（2026-09-19 堆爆修复的回归网）。
 *
 * 背景（真实事故）：`ContextEngine.walk` 曾自带一套只跳 `node_modules`/`dist`/点目录的遍历，
 * 与本仓 `WorkspaceFileWalker` 的忽略清单不一致 ⇒ 本工作区里 `eval-data/`（2.3 GB、
 * 10.4 万个随仓克隆的 `.py`）与 `target/`（2.2 GB Rust 构建产物）被全量读进内存，
 * `npm run smoke` 跑 7 分钟后 4 GB 堆爆。本文件把「哪些不该进语料」与「上限到了怎么如实回报」
 * 钉成可证伪断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextEngine, indexCorpus } from '../../src/context/contextEngine.js';

/** 建临时语料根。 */
const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'omni-corpus-'));

/**
 * 写文件（自动建父目录）。
 *
 * @param root 语料根
 * @param rel 相对路径
 * @param content 内容
 */
const write = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

test('walk：重目录（依赖/构建产物/基准语料/缓存/点目录）一律不进语料', () => {
  const root = makeRoot();
  write(root, 'src/keep.ts', 'export const keep = 1;\n');
  write(root, 'node_modules/pkg/a.js', 'module.exports = 1;\n');
  write(root, 'dist/b.js', 'var b = 1;\n');
  write(root, 'build/c.py', 'c = 1\n');
  write(root, 'target/d.py', 'd = 1\n');
  write(root, 'eval-data/e.py', 'e = 1\n');
  write(root, '.venv/f.py', 'f = 1\n');
  write(root, '__pycache__/g.py', 'g = 1\n');
  write(root, '.hidden/h.ts', 'export const h = 1;\n');

  const corpus = indexCorpus(root, { morph: true, light: true });
  const rels = [...corpus.fileText.keys()];
  assert.deepStrictEqual(rels, ['src/keep.ts'], `只应索引真实源码，实际 ${rels.join(',')}`);
  assert.strictEqual(corpus.truncated, false);
  assert.strictEqual(corpus.skippedLargeFiles, 0);
  rmSync(root, { recursive: true, force: true });
});

test('walk：单文件超过字节上限即不入图，并如实计数（不静默）', () => {
  const root = makeRoot();
  write(root, 'src/small.ts', 'export const s = 1;\n');
  write(root, 'src/huge.ts', `export const big = "${'x'.repeat(4096)}";\n`);
  const corpus = indexCorpus(root, { morph: true, light: true, maxFileBytes: 512 });
  assert.deepStrictEqual([...corpus.fileText.keys()], ['src/small.ts']);
  assert.strictEqual(corpus.skippedLargeFiles, 1, '被排除的大文件必须计数上报');
  rmSync(root, { recursive: true, force: true });
});

test('walk：文件数上限触顶 → truncated=true 且不无限吃内存', () => {
  const root = makeRoot();
  for (let i = 0; i < 6; i += 1) {
    write(root, `src/f${String(i)}.ts`, `export const v${String(i)} = ${String(i)};\n`);
  }
  const corpus = indexCorpus(root, { morph: true, light: true, maxFiles: 2 });
  assert.strictEqual(corpus.fileText.size, 2);
  assert.strictEqual(corpus.truncated, true, '触顶必须回报截断');
  rmSync(root, { recursive: true, force: true });
});

test('walk：语料总字节预算触顶 → truncated=true（文件数没到也会停）', () => {
  const root = makeRoot();
  for (let i = 0; i < 4; i += 1) {
    write(
      root,
      `src/big${String(i)}.ts`,
      `${'// 填充\n'.repeat(200)}export const b${String(i)} = 1;\n`,
    );
  }
  // 单文件约 2.0 KB；预算 2.5 KB ⇒ 恰好装下 1 个，第 2 个越界即截断（与文件数上限无关）。
  const corpus = indexCorpus(root, { morph: true, light: true, maxTotalBytes: 2500 });
  assert.strictEqual(
    corpus.fileText.size,
    1,
    `总预算应提前收口，实际纳入 ${String(corpus.fileText.size)} 个`,
  );
  assert.strictEqual(corpus.truncated, true);
  rmSync(root, { recursive: true, force: true });
});

test('full 模式索引大语料必须在日志里看得见（只告警、不改行为）', () => {
  const root = makeRoot();
  write(root, 'src/a.ts', `export const a = 1; // ${'x'.repeat(600)}\n`);
  const captured: string[] = [];
  const original = process.stderr.write;
  // 日志默认 sink 写 stderr；临时接管以断言「告警真的发了」。
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    indexCorpus(root, { morph: true, light: false, fullModeWarnBytes: 100 });
    assert.strictEqual(
      captured.some((line) => line.includes('full 模式索引较大语料')),
      true,
      '超过阈值必须以 warn 级别暴露（否则又会是「静默吃内存」）',
    );
    captured.length = 0;
    indexCorpus(root, { morph: true, light: true, fullModeWarnBytes: 100 });
    assert.strictEqual(
      captured.some((line) => line.includes('full 模式索引较大语料')),
      false,
      'light 模式不该报此告警',
    );
  } finally {
    process.stderr.write = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test('真机回归：索引本仓根目录不会再吞下 eval-data/target（堆爆事故同口径）', () => {
  const corpus = indexCorpus(process.cwd(), { morph: true, light: true });
  const rels = [...corpus.fileText.keys()];
  const leaked = rels.filter(
    (rel) =>
      rel.startsWith('eval-data/') ||
      rel.startsWith('target/') ||
      rel.startsWith('node_modules/') ||
      rel.startsWith('dist/'),
  );
  assert.deepStrictEqual(leaked.slice(0, 5), [], '重目录不得进语料');
  assert.ok(
    rels.length < ContextEngine.MAX_FILES,
    `真实仓库语料应有界（实际 ${String(rels.length)} 个文件）`,
  );
  assert.ok(
    rels.every((rel) => /\.(?:ts|js|py)$/.test(rel)),
    '只索引源码类型',
  );
});
