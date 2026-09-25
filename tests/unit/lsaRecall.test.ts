import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LsaEngine } from '../../src/context/lsaEngine.js';
import type { IndexedCorpus } from '../../src/context/contextEngine.js';

/** 构造最小 IndexedCorpus（trainLsa 仅依赖 symbols[].file 与 fileText）。 */
function buildCorpus(): IndexedCorpus {
  const files = ['a.ts', 'b.ts', 'c.ts'];
  const texts: Record<string, string> = {
    'a.ts': 'function sandbox policy evaluate execPolicy reject deny allow',
    'b.ts': 'evaluate policy sandbox decision grant revoke token',
    'c.ts': 'render button click component style color layout',
  };
  const symbols = files.map((f, i) => ({
    file: f,
    line: i + 1,
    kind: 'function' as const,
    name: `sym${i}`,
    signature: 'sig',
  }));
  const fileText = new Map<string, string>(files.map((f) => [f, texts[f] ?? '']));
  return { symbols, fileText } as unknown as IndexedCorpus;
}

describe('LSA 潜语义召回', () => {
  it('相同种子训练结果确定性一致（可复现）', () => {
    const c = buildCorpus();
    const m1 = LsaEngine.trainLsa(c, 16, 42);
    const m2 = LsaEngine.trainLsa(c, 16, 42);
    assert.strictEqual(m1.symLatent.length, m2.symLatent.length);
    for (let i = 0; i < m1.symLatent.length; i++) {
      assert.strictEqual(m1.symLatent[i], m2.symLatent[i]);
    }
  });

  it('query 返回按分数降序排列的命中', () => {
    const c = buildCorpus();
    const m = LsaEngine.trainLsa(c, 16, 42);
    const res = LsaEngine.lsaQuery(m, 'sandbox policy', 3);
    assert.ok(res.length > 0, '应有命中');
    for (let i = 1; i < res.length; i++) {
      assert.ok(res[i - 1]!.score >= res[i]!.score, '分数须非增');
    }
  });

  it('同模型同查询幂等（结果可复现）', () => {
    const c = buildCorpus();
    const m = LsaEngine.trainLsa(c, 16, 42);
    const r1 = LsaEngine.lsaQuery(m, 'evaluate decision');
    const r2 = LsaEngine.lsaQuery(m, 'evaluate decision');
    assert.deepStrictEqual(r1, r2);
  });

  it('不同种子产生不同投影基（随机性生效）', () => {
    const c = buildCorpus();
    const m1 = LsaEngine.trainLsa(c, 16, 1);
    const m2 = LsaEngine.trainLsa(c, 16, 999);
    let differs = false;
    for (let i = 0; i < m1.U.length; i++) {
      if (m1.U[i] !== m2.U[i]) {
        differs = true;
        break;
      }
    }
    assert.ok(differs, '不同种子应产生不同 U');
  });

  it('model 形状符合 LsaModel 契约（k/n 正确）', () => {
    const c = buildCorpus();
    const m = LsaEngine.trainLsa(c, 8, 7);
    assert.strictEqual(m.k, 8);
    assert.strictEqual(m.n, 3);
    assert.strictEqual(m.symLatent.length, m.n * m.k);
  });
});
