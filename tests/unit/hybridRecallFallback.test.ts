import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoMapContextEngine } from '../../src/context/repoMap/repoMapContextEngine.ts';
import type { EmbeddingPort } from '../../src/ports/model/embedding.ts';

/** 确定性伪嵌入（不依赖模型/网络；只用于接线判据，不用于质量数字）。 */
const fakeEmbedding = (dim = 8): EmbeddingPort => ({
  dim,
  embed: async (texts) =>
    texts.map((text) => {
      const v = new Array<number>(dim).fill(0);
      for (const ch of text.toLowerCase()) {
        const at = ch.charCodeAt(0) % dim;
        v[at] = (v[at] ?? 0) + 1;
      }
      return v;
    }),
});

/** 建一个最小可索引工作区。 */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omni-hybrid-guard-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'src', 'alpha.ts'),
    'export class AlphaService { run(): number { return 1; } }\n',
    'utf8',
  );
  await writeFile(
    join(root, 'src', 'beta.ts'),
    'export class BetaService { stop(): number { return 0; } }\n',
    'utf8',
  );
  return root;
}

test('混合检索：嵌入成功时走 hybrid 且 semanticFallbacks=0', async () => {
  const root = await workspace();
  try {
    const engine = new RepoMapContextEngine();
    const text = await engine.getHybridRepoMapContext(root, 'AlphaService', fakeEmbedding(), {
      fileK: 5,
    });
    assert.notStrictEqual(text, null);
    assert.match(text ?? '', /src[\\/]alpha\.ts/u);
    assert.strictEqual(engine.semanticFallbackTotal(), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('混合检索：嵌入抛错时 fail-closed 回落 BM25，且回落次数可见', async () => {
  const root = await workspace();
  try {
    const engine = new RepoMapContextEngine();
    const broken: EmbeddingPort = {
      dim: 8,
      embed: async () => {
        throw new Error('模型不可用（测试注入）');
      },
    };
    const text = await engine.getHybridRepoMapContext(root, 'BetaService', broken, { fileK: 5 });
    assert.notStrictEqual(text, null, '回落 BM25 仍应返回上下文');
    assert.strictEqual(engine.semanticFallbackTotal(), 1, '回落必须计数，不能静默');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
