import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PythonEnvPlan } from '../../src/eval/pythonEnvPlan.js';
import { at } from '../../src/util/arrayAt.js';

test('PythonEnvPlan.findTestRequirements：按优先级取首个存在者', () => {
  // 只存在第三档（django 的 tests/requirements/py3.txt）
  const first = PythonEnvPlan.findTestRequirements((rel) => rel === 'tests/requirements/py3.txt');
  assert.strictEqual(first, 'tests/requirements/py3.txt');

  // 同时存在多个 ⇒ 取优先级最高者（requirements/tests.txt 排第一）
  const picked = PythonEnvPlan.findTestRequirements(
    (rel) => rel === 'requirements/test.txt' || rel === 'requirements/tests.txt',
  );
  assert.strictEqual(picked, 'requirements/tests.txt');

  // 都不存在 ⇒ undefined
  assert.strictEqual(
    PythonEnvPlan.findTestRequirements(() => false),
    undefined,
  );
});

test('PythonEnvPlan.steps：仓库本体恒为首步；extras 紧随其后', () => {
  const steps = PythonEnvPlan.steps({ pins: [], pytestPresent: true });
  assert.deepEqual([...at(steps, 0).args], ['-e', '.']);
  assert.deepEqual([...at(steps, 1).args], ['-e', '.[test]']);
  assert.deepEqual([...at(steps, 2).args], ['-e', '.[tests]']);
});

test('PythonEnvPlan.steps：pytest 已存在 ⇒ 不生成兜底安装步（绝不覆盖仓库 pin）', () => {
  const steps = PythonEnvPlan.steps({ pins: [], pytestPresent: true });
  assert.ok(
    !steps.some((s) => s.args.length === 1 && at(s.args, 0) === 'pytest'),
    'pytest 已存在时不得再出现裸 pytest 安装步',
  );
});

test('PythonEnvPlan.steps：pytest 缺失 ⇒ 兜底步必为末步且仅装 pytest', () => {
  const steps = PythonEnvPlan.steps({
    requirementsFile: 'requirements/tests.txt',
    pins: ['Werkzeug<3'],
    pytestPresent: false,
  });
  const last = at(steps, steps.length - 1);
  assert.deepEqual([...last.args], ['pytest']);
  // 顺序不变量：已 pinned 测试依赖 → 额外约束 → 兜底 pytest
  const reqIdx = steps.findIndex((s) => at(s.args, 0) === '-r');
  const pinIdx = steps.findIndex((s) => at(s.args, 0) === 'Werkzeug<3');
  const pyIdx = steps.length - 1;
  assert.ok(reqIdx >= 0 && pinIdx >= 0, 'pinned 依赖与额外约束步都应存在');
  assert.ok(reqIdx < pinIdx && pinIdx < pyIdx, '顺序须为 已pinned依赖 → 额外约束 → pytest');
});

test('PythonEnvPlan.steps：pins 为空时不生成额外约束步', () => {
  const steps = PythonEnvPlan.steps({ pins: [], pytestPresent: true });
  assert.ok(!steps.some((s) => s.label.includes('额外约束')), 'pins 为空时不得生成额外约束步');
});
