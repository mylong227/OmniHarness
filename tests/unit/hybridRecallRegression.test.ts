import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingPort } from '../../src/ports/model/embedding/embeddingPort.ts';
import type { Embedding } from '../../src/ports/model/embedding/embedding.ts';
import { RepoMapContextEngine } from '../../src/context/repoMap/repoMapContextEngine.ts';

/**
 * 混合检索**生产默认路径**的回归判据（2026-10-24）。
 *
 * 为什么需要它：CLI 默认开语义召回，但真模型探针只在有 23MB 权重时才能跑；缺模型时
 * 既有门禁只看纯 BM25，于是「语义路静默回落」与「语义路本来就没用」长得一模一样。
 * 本判据用**确定性伪嵌入**钉住两件事：
 * ① 混合路径的 RRF 融合确实把语义命中抬进上下文（不依赖真模型）；
 * ② 嵌入失败时**可观测地**回落 BM25（`semanticFallbackTotal()` 必须 +1），不允许静默。
 */

/** 伪嵌入：按关键词落在正交维度上；未命中词给微弱基线，保证向量非零。 */
class KeywordEmbedding implements EmbeddingPort {
  public readonly dim = 4;

  public async embed(texts: readonly string[]): Promise<readonly Embedding[]> {
    return texts.map((text) => {
      const v = [0.01, 0.01, 0.01, 0.01];
      if (text.includes('alpha')) v[0] = 1;
      if (text.includes('beta')) v[1] = 1;
      if (text.includes('gamma')) v[2] = 1;
      return v;
    });
  }
}

/** 建一个只含两个源文件的最小工作区。 */
function makeWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'omni-hybrid-'));
  writeFileSync(
    join(root, 'alpha.ts'),
    'export function alphaAnchor(): string {\n  return "alpha";\n}\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'beta.ts'),
    'export function betaAnchor(): string {\n  return "beta";\n}\n',
    'utf8',
  );
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('混合检索：伪嵌入命中进入上下文，且零语义回落', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const engine = new RepoMapContextEngine();
    const text = await engine.getHybridRepoMapContext(root, 'alpha', new KeywordEmbedding(), {
      fileK: 2,
    });
    assert.ok(text !== null, '混合路径应产出上下文');
    assert.match(text, /alpha\.ts/u, '语义命中的 alpha.ts 必须进入上下文');
    assert.strictEqual(engine.semanticFallbackTotal(), 0, '伪嵌入可用时不得回落');
  } finally {
    cleanup();
  }
});

test('混合检索：嵌入失败可见地回落 BM25，而不是静默当成功', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const failing: EmbeddingPort = {
      dim: 4,
      embed: async () => {
        throw new Error('embedding unavailable');
      },
    };
    const engine = new RepoMapContextEngine();
    const text = await engine.getHybridRepoMapContext(root, 'alpha', failing, { fileK: 2 });
    assert.ok(text !== null, '语义失败仍应给出 BM25 上下文（fail-closed，不丢上下文）');
    assert.strictEqual(engine.semanticFallbackTotal(), 1, '回落必须被计数，供探针/遥测发现');
  } finally {
    cleanup();
  }
});
