// T4.6（评测与生成路径隔离）可证伪验收：
//   ① 隔离生效：生成后篡改活产物 → verdict 不变（自评偏差的共享状态通道被切断）；
//   ② 冻结：评估器内篡改快照即抛（fail-closed，无法借评估口改产物）；
//   ③ project 投影生效：评估只见投影形状；
//   ④ fail-closed：不可克隆产物（含函数）显式抛错，拒绝活引用评估；
//   ⑤ 确定性：同产物重复评估 20 次 verdict 恒同。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateIsolated, deepFreeze } from '../../src/eval/isolatedEvaluator.js';

interface Artifact {
  files: string[];
  passed: boolean;
}

test('① 隔离生效：生成后篡改活产物，verdict 不变', async () => {
  const live: Artifact = { files: ['a.ts'], passed: true };
  const first = await evaluateIsolated<Artifact>({
    generate: () => live,
    evaluate: (s) => (s.passed && s.files.length === 1 ? 1 : 0),
  });
  assert.strictEqual(first.verdict, 1);

  // 生成路径此后修改活产物（真实场景：agent 评估期间继续改文件清单）。
  live.files.push('b.ts');
  live.passed = false;
  const second = await evaluateIsolated<Artifact>({
    generate: () => live,
    evaluate: (s) => (s.passed && s.files.length === 1 ? 1 : 0),
  });
  // 隔离不等于时间冻结：再次 generate 拿的是新状态——隔离保证的是「单次评估内零共享」。
  assert.strictEqual(second.verdict, 0, '新一次评估如实反映新状态');

  // 关键断言：单次评估内，评估进行中篡改活对象不影响已产出的快照 verdict。
  const live2: Artifact = { files: ['a.ts'], passed: true };
  const v = await evaluateIsolated<Artifact>({
    generate: () => live2,
    evaluate: (s) => {
      live2.files.push('injected.ts'); // 评估执行中污染活对象
      live2.passed = false;
      return s.passed && s.files.length === 1 ? 1 : 0; // 快照仍是入参时状态
    },
  });
  assert.strictEqual(v.verdict, 1, '评估中途篡改活对象不得影响本次 verdict');
  assert.deepStrictEqual(v.snapshot.files, ['a.ts'], '快照不含评估期间注入的内容');
});

test('② 冻结：评估器内篡改快照即抛（无法借评估口改产物）', async () => {
  await assert.rejects(
    () =>
      evaluateIsolated<Artifact>({
        generate: () => ({ files: ['a.ts'], passed: true }),
        evaluate: (s) => {
          (s as { passed: boolean }).passed = false;
          return 1;
        },
      }),
    /read only|read-only/i,
  );
});

test('③ project 投影：评估只见投影形状', async () => {
  const full = { files: ['a.ts'], passed: true, secretToken: 'sk-xxx' };
  const r = await evaluateIsolated<typeof full, { passed: boolean }>({
    generate: () => full,
    project: (a) => ({ passed: a.passed }),
    evaluate: (s) => {
      assert.strictEqual(Object.keys(s as object).length, 1, '快照只含投影字段');
      return s.passed ? 1 : 0;
    },
  });
  assert.strictEqual(r.verdict, 1);
  assert.strictEqual('secretToken' in r.snapshot, false, '敏感字段不进快照');
});

test('④ fail-closed：不可克隆产物（含函数）显式抛错', async () => {
  await assert.rejects(
    () =>
      evaluateIsolated({
        generate: () => ({ run: () => 1 }),
        evaluate: () => 1,
      }),
    /不可结构化克隆/,
  );
});

test('⑤ deepFreeze 逐层 + 确定性：同产物重复评估 20 次 verdict 恒同', async () => {
  const nested = deepFreeze({ a: { b: { c: 1 } } });
  assert.ok(Object.isFrozen(nested) && Object.isFrozen((nested as { a: object }).a));
  const run = () =>
    evaluateIsolated<Artifact>({
      generate: () => ({ files: ['x.ts', 'y.ts'], passed: true }),
      evaluate: (s) => s.files.length * (s.passed ? 0.5 : 0),
    });
  const first = await run();
  for (let i = 0; i < 19; i++) {
    const r = await run();
    assert.strictEqual(r.verdict, first.verdict, '同产物必须恒同 verdict');
    assert.deepStrictEqual(r.snapshot, first.snapshot);
  }
  assert.strictEqual(first.verdict, 1);
});
