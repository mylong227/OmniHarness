// T4.1（H1 自验证清单）可证伪验收：
//   ① 「假完成」用例被抓出：声称完成但测试红 / 产物文件缺失 / 占位符残留 → assertDone 抛错；
//   ② 诚实完成用例通过且不误伤（成功率不降）；
//   ③ fail-closed：验证函数抛错 = 不过；
//   ④ 同输入重复评估结果稳定（确定性，无隐藏随机源）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SelfChecklist } from '../../src/eval/selfChecklist.js';

test('① 假完成拦截：占位符残留的"完成报告"必须判负', async () => {
  const checklist = new SelfChecklist().noPlaceholders(
    '已完成全部 17 个文件的迁移。TODO：剩余 3 个文件后续补。',
  );
  const verdict = await checklist.evaluate();
  assert.strictEqual(verdict.passed, false, '含 TODO/后续补 的完成声明必须判负');
  assert.ok(verdict.failures.includes('no-placeholders'));
  await assert.rejects(() => checklist.assertDone(), /假完成拦截/);
});

test('①b 假完成拦截：声称完成但测试判据为红', async () => {
  const checklist = new SelfChecklist()
    .criterion('tests-green', '受影响单测全绿', () => false) // 模拟测试红
    .criterion('files-exist', '产物文件存在', () => true);
  const verdict = await checklist.evaluate();
  assert.strictEqual(verdict.passed, false);
  assert.deepStrictEqual(verdict.failures, ['tests-green']);
});

test('①c 假完成拦截：声称写出的产物文件实际不存在', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'omni-checklist-'));
  try {
    const checklist = new SelfChecklist().criterion('artifact-exists', '产物 src/foo.ts 存在', () =>
      existsSync(join(ws, 'src', 'foo.ts')),
    );
    assert.strictEqual((await checklist.evaluate()).passed, false, '文件不存在必须判负');

    // 补上产物后同一判据转绿（判据是机械验证，不因声明改变）。
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'foo.ts'), 'export {}');
    assert.strictEqual((await checklist.evaluate()).passed, true, '产物真实存在后应通过');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('② 诚实完成：全部判据绿则通过，assertDone 不抛（不误伤真完成）', async () => {
  const checklist = new SelfChecklist()
    .criterion('compile', 'typecheck 零错误', () => true)
    .criterion('tests', '相关单测通过', async () => true)
    .noPlaceholders('完成 17/17 个文件迁移，全部含 @param/@returns。');
  await checklist.assertDone(); // 不抛即通过
  const v = await checklist.evaluate();
  assert.strictEqual(v.results.length, 3);
});

test('③ fail-closed：验证函数抛错 = 不过（异常不得视为通过）', async () => {
  const checklist = new SelfChecklist().criterion('boom', '会抛错的判据', () => {
    throw new Error('runner crashed');
  });
  const v = await checklist.evaluate();
  assert.strictEqual(v.passed, false);
  assert.match(v.results[0]!.reason ?? '', /runner crashed/);
});

test('④ 确定性：同输入重复评估 20 次结果完全稳定', async () => {
  const run = async () => {
    const c = new SelfChecklist()
      .criterion('a', 'A', () => true)
      .criterion('b', 'B', () => false)
      .noPlaceholders('done，无遗留。');
    return (await c.evaluate()).failures;
  };
  const first = await run();
  for (let i = 0; i < 19; i++) {
    assert.deepStrictEqual(await run(), first, '同输入必须恒同判定');
  }
  assert.deepStrictEqual(first, ['b']);
});
