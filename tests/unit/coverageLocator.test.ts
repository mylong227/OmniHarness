import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CoverageLocator } from '../../src/eval/coverageLocator.js';

test('ochiai：失败测试独占覆盖的可疑度高于共享覆盖', () => {
  // 仅失败测试覆盖 ⇒ susp=1；失败+通过都覆盖 ⇒ susp<1；无覆盖 ⇒ 0。
  assert.strictEqual(CoverageLocator.ochiai(1, 0, 0), 1);
  assert.ok(CoverageLocator.ochiai(1, 0, 1) < 1 && CoverageLocator.ochiai(1, 0, 1) > 0);
  assert.strictEqual(CoverageLocator.ochiai(0, 1, 5), 0);
  // 分母 0 且无失败覆盖 ⇒ 0（fail-closed，不假阳）。
  assert.strictEqual(CoverageLocator.ochiai(0, 0, 0), 0);
});

test('rankFilesFromCoverageJson：按覆盖语句数降序，忽略 0 覆盖', () => {
  const json = JSON.stringify({
    files: {
      'src/bad.py': { summary: { covered_lines: 42 } },
      'src/good.py': { summary: { covered_lines: 8 } },
      'src/unused.py': { summary: { covered_lines: 0 } },
    },
  });
  const ranked = CoverageLocator.rankFilesFromCoverageJson(json);
  assert.deepStrictEqual(
    ranked.map((r) => r.file),
    ['src/bad.py', 'src/good.py'],
  );
  assert.strictEqual(ranked[0]?.score, 42);
});

test('rankFilesFromCoverageJson：非法 JSON 返回空（fail-closed）', () => {
  assert.deepStrictEqual(CoverageLocator.rankFilesFromCoverageJson('not json'), []);
});

test('prependBoosted：SBFL 文件去重前置，不重复检索已命中项', () => {
  const boosted = [
    { file: 'src/bad.py', score: 42 },
    { file: 'src/ok.py', score: 10 },
  ];
  const retrieved = ['src/ok.py', 'src/other.py'];
  const merged = CoverageLocator.prependBoosted(boosted, retrieved, 5);
  assert.deepStrictEqual(merged, ['src/bad.py', 'src/ok.py', 'src/other.py']);
});

test('prependBoosted：limit 截断前置数量', () => {
  const boosted = [
    { file: 'a.py', score: 9 },
    { file: 'b.py', score: 8 },
    { file: 'c.py', score: 7 },
  ];
  const merged = CoverageLocator.prependBoosted(boosted, ['z.py'], 2);
  assert.deepStrictEqual(merged, ['a.py', 'b.py', 'z.py']);
});
