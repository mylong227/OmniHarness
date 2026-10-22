/**
 * trace → patch 提案器判据：失败识别、文件/命令提取、确定性、截断、只提案不改文件。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TracePatchPlanner } from '../../src/eval/tracePatchPlanner.ts';

test('从失败工具结果提取证据/文件/命令，生成四步计划', () => {
  const plan = TracePatchPlanner.plan([
    {
      tool: 'bash',
      ok: false,
      command: 'npm test -- tests/unit/foo.test.ts',
      output: 'AssertionError: expected 1\n    at src/core/foo.ts:12:3',
    },
    { tool: 'edit', ok: true, path: 'src/core/foo.ts' },
  ]);
  assert.deepStrictEqual(
    plan.failures.map((failure) => failure.tool),
    ['bash'],
  );
  assert.ok(plan.files.includes('src/core/foo.ts'));
  assert.deepStrictEqual(plan.commands, ['npm test -- tests/unit/foo.test.ts']);
  assert.deepStrictEqual(
    plan.steps.map((step) => step.id),
    ['reproduce', 'inspect', 'fix', 'verify'],
  );
  assert.match(TracePatchPlanner.toMarkdown(plan), /trace → patch 计划/u);
});

test('确定性：同输入同输出（文件/命令排序）', () => {
  const signals = [
    { tool: 'a', ok: false, output: 'ENOENT src/b.ts and src/a.ts' },
    { tool: 'b', ok: false, output: 'failed', path: 'src/c.ts' },
  ];
  const first = TracePatchPlanner.plan(signals);
  const second = TracePatchPlanner.plan([...signals].reverse());
  assert.deepStrictEqual(first.files, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.deepStrictEqual(first.steps, second.steps);
});

test('成功输出不成为失败证据；长证据截断到 400 字符', () => {
  const clean = TracePatchPlanner.plan([{ tool: 'bash', ok: true, output: 'all good' }]);
  assert.strictEqual(clean.failures.length, 0);
  const long = TracePatchPlanner.plan([
    { tool: 'bash', ok: false, output: `AssertionError ${'x'.repeat(1000)}` },
  ]);
  assert.strictEqual(long.failures[0]?.excerpt.length, 401);
  assert.match(long.failures[0]?.excerpt ?? '', /…$/u);
});

test('文件提取：tsx/json 不截断；URL 不当作文件；Windows 盘符保留；去重', () => {
  const plan = TracePatchPlanner.plan([
    {
      tool: 'bash',
      ok: false,
      output:
        'src/ui/view.tsx and src/conf/config.json and src/ui/view.tsx; C:\\work\\src\\a.ts; https://example.com/x/y.ts',
    },
  ]);
  assert.deepStrictEqual(plan.files, [
    'C:\\work\\src\\a.ts',
    'src/conf/config.json',
    'src/ui/view.tsx',
  ]);
});

test('失败判定：ok undefined + 失败文本算失败；ok:true 即使含 error 也不算', () => {
  const failed = TracePatchPlanner.plan([{ tool: 'bash', output: 'AssertionError: boom' }]);
  assert.strictEqual(failed.failures.length, 1);
  const passed = TracePatchPlanner.plan([
    { tool: 'bash', ok: true, output: 'AssertionError in expected output (test fixture)' },
  ]);
  assert.strictEqual(passed.failures.length, 0);
  const empty = TracePatchPlanner.plan([{ tool: 'bash', ok: false, output: '' }]);
  assert.strictEqual(empty.failures.length, 1);
});
