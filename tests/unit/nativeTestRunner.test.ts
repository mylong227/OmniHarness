/**
 * 测试失败**短诊断**的单测（`NativeTestRunner.diagnose`）。
 *
 * 背景：gold 对照报告里 26 个实例只记 `resolved=false` 而**无原因**，「环境没装好」「测试选择口径不对」
 * 「真的没修好」三类混在一起不可分，判分可信度调查在报告层就断了线索。本诊断负责把三类分流。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeTestRunner } from '../../src/eval/nativeTestRunner.js';

test('diagnose：命令完全无输出 ⇒ 直指「命令形态/流捕获可疑」', () => {
  assert.match(NativeTestRunner.diagnose('   \n\n'), /无任何输出/);
});

test('diagnose：pytest 收集错误（依赖没装齐）', () => {
  const out = [
    '=========================== short test summary info ===========================',
    'ERROR tests/test_core.py',
    '=============================== ERRORS ===============================',
    'ERROR collecting tests/test_core.py',
    "ImportError: cannot import name 'erfa' from 'astropy'",
  ].join('\n');
  assert.match(NativeTestRunner.diagnose(out), /收集错误/);
});

test('diagnose：conftest 导入失败', () => {
  const out = 'ImportError while loading conftest/Users/x/tests/conftest.py';
  assert.match(NativeTestRunner.diagnose(out), /conftest 导入失败/);
});

test('diagnose：零收集 ⇒ 指向测试选择口径', () => {
  assert.match(NativeTestRunner.diagnose('collected 0 items / 1 error'), /零收集/);
  assert.match(NativeTestRunner.diagnose('no tests ran in 0.01s'), /零执行/);
});

test('diagnose：django 的 `_FailedTest`（directive 形态不对）', () => {
  const out = 'test_x (unittest.loader._FailedTest) ... ERROR';
  assert.match(NativeTestRunner.diagnose(out), /无法导入/);
});

test('diagnose：真的只是测试失败（无环境/口径线索）⇒ 空诊断，不制造假信号', () => {
  const out = [
    'test_a (mod.ClassA) ... ok',
    'test_b (mod.ClassA) ... FAIL',
    'Ran 2 tests in 0.01s',
    'FAILED (failures=1)',
  ].join('\n');
  assert.strictEqual(NativeTestRunner.diagnose(out), '');
});

test('diagnose：启动期崩溃（Traceback，无任何结果行）不得被读成「测试失败」', () => {
  // 实证两例：pytest 4.5 + 新版 setuptools 自带 typeguard 插件（AssertionError）；
  // sphinx 3.3 + jinja2 3.1（ImportError: cannot import name 'environmentfilter'）。
  const out = [
    'Traceback (most recent call last):',
    '  File "site-packages/pluggy/callers.py", line 187, in _multicall',
    '    res = hook_impl.function(*args)',
    '  File "site-packages/setuptools/_vendor/typeguard/_pytest_plugin.py", line 22',
    '    parser.addini(',
    'AssertionError',
  ].join('\n');
  assert.match(NativeTestRunner.diagnose(out), /测试运行崩溃/);
});

test('describeFailure：官方解析器换行产物 id（`[100%]`）必须被点名为「非测试」', () => {
  const run = {
    passed: new Map([['real_test', true]]),
    diagnosis: '',
  };
  const text = NativeTestRunner.describeFailure(['real_test'], ['[100%]'], run);
  assert.match(text, /PASS_TO_PASS 0\/1/);
  assert.match(
    text,
    /换行产物 id（非测试）/,
    '`[100%]` 必须被解释为数据集/解析器产物而不是失败测试',
  );
  // 不含此类 id 时不得出现该提示（避免噪声）
  const clean = NativeTestRunner.describeFailure([], ['real_test'], run);
  assert.ok(!clean.includes('换行产物'), '普通失败不得带该提示');
});
