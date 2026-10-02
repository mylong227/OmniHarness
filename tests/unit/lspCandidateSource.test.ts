/**
 * LSP 候选源（LspCandidateSource）组件级单测 —— repo-map 召回 opt-in 第四路。
 *
 * 用**假 LspPort**（无需真实语言服务器）验证四件事：
 * 1. **主路径**：BM25 seed 符号 → `lsp.references` 扩展 → 把被引用文件作为 `file:<rel>` 候选注入。
 * 2. **fail-closed**：LSP 抛错 → 整体返回空候选，绝不崩主流程。
 * 3. **延迟有界**：LSP 永不响应 → `perCallTimeoutMs` 内超时返回空，不挂起。
 * 4. **越界过滤**：LSP 返回 root 之外的位置 → 被丢弃，不污染候选集。
 *
 * 真实子进程往返（typescript-language-server 是否能在真实仓库产出有效引用 / 耗时 / 失败率）
 * 由 `evals/probe-lsp-candidates.mjs` 的 offline probe 校验（需配置服务器，本仓不默认开启）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContextEngine } from '../../src/context/contextEngine.js';
import type { IndexedCorpus } from '../../src/context/contextEngine.js';
import { LspCandidateSource } from '../../src/context/lspCandidateSource.js';
import type { LspLocation, LspPort } from '../../src/ports/tool/lsp.js';

/** 夹具：把「文件内容 → 临时语料」的搭建收口（与 fileReranker.test.ts 同口径）。 */
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
    const dir = mkdtempSync(join(tmpdir(), 'lsp-cand-'));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, 'utf8');
    }
    return { dir, corpus: ContextEngine.indexCorpus(dir, { morph: true, light: true }) };
  }
}

/** 声明 targetSymbol（被引用目标，第 2 行）。 */
const A_TS = ['// anchor comment', 'export function targetSymbol(): void {', '  return;', '}'].join(
  '\n',
);

/** 在第 2 行调用 targetSymbol（fake LSP 将把此位置作为引用回报）。 */
const B_TS = ['export function caller(): void {', '  targetSymbol();', '}'].join('\n');

/** 无关文件。 */
const C_TS = ['export function unrelated(): number {', '  return 3;', '}'].join('\n');

/**
 * 构造假 LSP 端口：references 行为由 `referencesImpl` 注入，其余方法恒返回空/未定义（fail-closed 测试用）。
 * @param referencesImpl 自定义 references 行为（主路径 / 抛错 / 超时场景）
 * @returns 假 LspPort
 */
function makeFakeLsp(referencesImpl: LspPort['references']): LspPort {
  return {
    name: 'fake',
    references: referencesImpl,
    definition: async () => [],
    hover: async () => undefined,
    shutdown: async () => {},
  };
}

test('主路径：BM25 seed → references 扩展 → 注入被引用文件为 file 候选', async () => {
  const { dir, corpus } = Fixture.build({ 'a.ts': A_TS, 'b.ts': B_TS, 'c.ts': C_TS });
  try {
    const absA = join(dir, 'a.ts');
    const absB = join(dir, 'b.ts');
    const defaultRefs: LspPort['references'] = async (file: string) =>
      file === absA
        ? [
            {
              uri: absB,
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
            },
          ]
        : [];
    const src = new LspCandidateSource();
    const ids = await src.candidatesFor('targetSymbol', makeFakeLsp(defaultRefs), corpus);
    assert.ok(
      ids.fileIds.includes('file:b.ts'),
      `应注入被引用文件 b.ts，实际：${ids.fileIds.join(',')}`,
    );
    // a.ts 自身不是 references 回报的位置（fake 只回报 b.ts），故不应出现在结果中。
    assert.ok(!ids.fileIds.includes('file:a.ts'), 'a.ts 不应被当作扩展候选');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fail-closed：LSP 抛错 → 返回空候选，不抛异常', async () => {
  const { dir, corpus } = Fixture.build({ 'a.ts': A_TS, 'b.ts': B_TS, 'c.ts': C_TS });
  try {
    const throwing: LspPort['references'] = async () => {
      throw new Error('lsp down');
    };
    const src = new LspCandidateSource();
    const ids = await src.candidatesFor('targetSymbol', makeFakeLsp(throwing), corpus);
    assert.deepStrictEqual(ids, { symIds: [], fileIds: [] }, 'LSP 异常须 fail-closed 返回空');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('延迟有界：LSP 永不响应 → 超时内返回空，不挂起', { timeout: 3000 }, async () => {
  const { dir, corpus } = Fixture.build({ 'a.ts': A_TS, 'b.ts': B_TS, 'c.ts': C_TS });
  try {
    const hanging: LspPort['references'] = () => new Promise<readonly LspLocation[]>(() => {});
    const src = new LspCandidateSource();
    const start = Date.now();
    const ids = await src.candidatesFor('targetSymbol', makeFakeLsp(hanging), corpus, {
      perCallTimeoutMs: 40,
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1500, `应在超时附近返回而非挂起，实际耗时 ${elapsed}ms`);
    assert.deepStrictEqual(ids, { symIds: [], fileIds: [] }, '超时须返回空候选');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('越界过滤：LSP 返回 root 之外的位置 → 被丢弃', async () => {
  const { dir, corpus } = Fixture.build({ 'a.ts': A_TS, 'b.ts': B_TS, 'c.ts': C_TS });
  try {
    const absA = join(dir, 'a.ts');
    const absB = join(dir, 'b.ts');
    const outside: LspPort['references'] = async (file: string) =>
      file === absA
        ? [
            {
              uri: absB,
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
            },
            {
              uri: '/somewhere/outside.ts',
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            },
          ]
        : [];
    const src = new LspCandidateSource();
    const ids = await src.candidatesFor('targetSymbol', makeFakeLsp(outside), corpus);
    assert.ok(ids.fileIds.includes('file:b.ts'), 'root 内位置应保留');
    assert.ok(!ids.fileIds.includes('file:'), 'root 外位置必须被过滤（不得出现空 rel 的 file:）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
