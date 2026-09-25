/**
 * 精排默认档行为钉（2026-09-25 回关决策的可证伪回归）。
 *
 * 决策依据：51 条新查询经第二方复核修正后，`evals/rerank-ab.mjs` 改接全量 84 条复跑，
 * 基准档 CI 下界 −1.59pp ⇒ 两关未过，生产默认从「开」回关为「关（opt-in）」。
 * 本文件把该决策钉进单测：
 *  1) 默认调用（无 env、无 opts）必须与显式 `rerank: false` **逐字相同**；
 *  2) `OMNI_RERANK=1` 必须与显式 `rerank: true` **逐字相同**（env 旋钮真的生效）；
 *  3) 在本语料上 opt-in 与默认**产出可区分**（精排把符号 IDF 覆盖高的文件提前——防死旋钮）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoMapContextEngine } from '../../src/context/repoMapContextEngine.js';

/**
 * 精排敏感语料：`beta.ts` 靠词频堆砌（tool ×3）在首段 BM25 抢到首位，
 * 而 `alpha.ts` 的符号名 `AlphaTool` 恰好高覆盖查询词——精排（符号 IDF 覆盖）会把
 * 它重新提到首位 ⇒ 默认（关）与 opt-in（开）产出确定不同。
 *
 * @returns 临时工作区根（用例结束后由调用方清理）。
 */
function rerankSensitiveRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'omniharness-rerank-default-'));
  const files: Record<string, string> = {
    'alpha.ts': 'export class AlphaTool {\n  run() { return 1; }\n}\n',
    'beta.ts': '// tool tool tool\nexport class BetaStore {\n  run() { return 2; }\n}\n',
    'gamma.ts': '// tool helper\nexport class GammaRender {\n  run() { return 3; }\n}\n',
    'delta.ts': 'export class DeltaParse {\n  run() { return 4; }\n}\n',
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  return root;
}

test('精排默认档：无 env 无 opts 必须逐字等价于显式 rerank:false', () => {
  const root = rerankSensitiveRepo();
  try {
    delete process.env.OMNI_RERANK;
    const engine = new RepoMapContextEngine();
    const query = 'alpha tool run';
    const opts = { fileK: 3, symK: 12 };
    assert.strictEqual(
      engine.getRepoMapContext(root, query, opts),
      engine.getRepoMapContext(root, query, { ...opts, rerank: false }),
      '默认必须回关：默认产出 == 显式 rerank:false',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('精排 opt-in：OMNI_RERANK=1 必须逐字等价于显式 rerank:true', () => {
  const root = rerankSensitiveRepo();
  try {
    process.env.OMNI_RERANK = '1';
    try {
      const engine = new RepoMapContextEngine();
      const query = 'alpha tool run';
      const opts = { fileK: 3, symK: 12 };
      assert.strictEqual(
        engine.getRepoMapContext(root, query, opts),
        engine.getRepoMapContext(root, query, { ...opts, rerank: true }),
        'env opt-in 必须生效：OMNI_RERANK=1 产出 == 显式 rerank:true',
      );
    } finally {
      delete process.env.OMNI_RERANK;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('精排在本语料上产出可区分（防死旋钮）：opt-in 把 AlphaTool 提到首位', () => {
  const root = rerankSensitiveRepo();
  try {
    delete process.env.OMNI_RERANK;
    const engine = new RepoMapContextEngine();
    const query = 'alpha tool run';
    const opts = { fileK: 3, symK: 12 };
    const off = engine.getRepoMapContext(root, query, { ...opts, rerank: false }) ?? '';
    const on = engine.getRepoMapContext(root, query, { ...opts, rerank: true }) ?? '';
    assert.notStrictEqual(off, on, '本语料上默认与 opt-in 产出必须可区分');
    const firstSurfaced = (text: string): string =>
      text
        .split('\n')
        .find((line) => line.startsWith('📄 '))
        ?.replace(/^📄\s*/, '') ?? '';
    assert.strictEqual(firstSurfaced(on), 'alpha.ts', '精排应把符号覆盖最高的文件提前');
    assert.strictEqual(firstSurfaced(off), 'beta.ts', '首段 BM25 按词频把 beta.ts 排前');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
