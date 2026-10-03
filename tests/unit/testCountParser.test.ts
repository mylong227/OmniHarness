/**
 * 测试计数解析器的用例（2026-10-03 第五轮）。
 *
 * 背景（已实测）：`node --test "dist/tests/unit/__nonexistent__*.test.js"` 输出
 * `# tests 0 / # pass 0 / # fail 0` 且 **exit = 0**，而完成闸门原判据只看 `exitCode !== 0`
 * ⇒ "没跑任何测试"会被判成"验证通过"。本文件钉住解析口径，闸门侧另有 `turnEndCompletionGate.test.ts`。
 *
 * 口径要点（刻意不做过度 fail-closed）：
 *  - 只认**显式零测试证据**（`# tests 0` / `collected 0 items` / `no tests ran` / `no test files` …）；
 *  - 拿不到汇总行（截断 / 非测试命令如 `tsc --noEmit`）⇒ `zeroEvidence === false`，闸门放行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TestCountParser } from '../../src/adapters/tool/verify/testCountParser.js';

test('① node --test：正常汇总解析出 total/passed/failed，且无零测试证据', () => {
  const output = ['# tests 12', '# suites 3', '# pass 11', '# fail 1', '# duration_ms 42'].join(
    '\n',
  );
  const r = TestCountParser.parse('node --test "dist/tests/unit/*.test.js"', output);
  assert.strictEqual(r.runner, 'node-test');
  assert.strictEqual(r.total, 12);
  assert.strictEqual(r.passed, 11);
  assert.strictEqual(r.failed, 1);
  assert.strictEqual(r.zeroEvidence, false);
});

test('② node --test：glob 落空（# tests 0）⇒ 必须给出零测试证据', () => {
  const output = ['# tests 0', '# pass 0', '# fail 0', '# duration_ms 3'].join('\n');
  const r = TestCountParser.parse('node --test "dist/tests/unit/__nonexistent__*.test.js"', output);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.zeroEvidence, true, '零测试是硬证据，闸门必须拦');
});

test('③ npm test 包装命令：命令看不出运行器时靠输出兜底', () => {
  const output = ['# tests 5', '# pass 5', '# fail 0'].join('\n');
  const r = TestCountParser.parse('npm test', output);
  assert.strictEqual(r.runner, 'node-test', '包装命令必须能靠输出识别运行器');
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.zeroEvidence, false);
});

test('④ jest：Tests 汇总行与 No test files found 两种形态', () => {
  const ok = TestCountParser.parse(
    'npx jest',
    ['Tests:       1 failed, 2 passed, 3 total', 'Test Suites: 1 failed, 1 passed, 2 total'].join(
      '\n',
    ),
  );
  assert.strictEqual(ok.runner, 'jest');
  assert.strictEqual(ok.total, 3);
  assert.strictEqual(ok.passed, 2);
  assert.strictEqual(ok.failed, 1);

  const empty = TestCountParser.parse('npx jest', 'No test files found, exiting with code 1');
  assert.strictEqual(empty.zeroEvidence, true);
});

test('⑤ vitest：Tests  10 passed (10) 与 no test files', () => {
  const ok = TestCountParser.parse(
    'npx vitest run',
    ['Test Files  2 passed (2)', 'Tests  10 passed (10)'].join('\n'),
  );
  assert.strictEqual(ok.runner, 'vitest');
  assert.strictEqual(ok.total, 10);
  assert.strictEqual(ok.passed, 10);
  assert.strictEqual(ok.zeroEvidence, false);

  const empty = TestCountParser.parse('npx vitest run', 'No test files found');
  assert.strictEqual(empty.zeroEvidence, true);
});

test('⑥ pytest：汇总行计数，collected 0 items / no tests ran 计为零测试证据', () => {
  const ok = TestCountParser.parse('pytest -q', '=== 3 passed, 1 failed in 0.42s ===');
  assert.strictEqual(ok.runner, 'pytest');
  assert.strictEqual(ok.passed, 3);
  assert.strictEqual(ok.failed, 1);
  assert.strictEqual(ok.total, 4, 'total 口径 = passed + failed');

  const collectedZero = TestCountParser.parse('python -m pytest tests/', 'collected 0 items');
  assert.strictEqual(collectedZero.zeroEvidence, true);

  const noTestsRan = TestCountParser.parse('pytest', 'no tests ran in 0.01s');
  assert.strictEqual(noTestsRan.zeroEvidence, true);
});

test('⑦ go test：no test files 计零测试证据；ok 行不臆造用例数', () => {
  const empty = TestCountParser.parse('go test ./...', '?   example/pkg [no test files]');
  assert.strictEqual(empty.zeroEvidence, true);

  const ok = TestCountParser.parse('go test ./...', 'ok  \texample/pkg\t0.123s');
  assert.strictEqual(ok.runner, 'go-test');
  assert.strictEqual(ok.total, 0, 'go 的 ok 行只说包通过，不臆造计数');
  assert.strictEqual(ok.zeroEvidence, false, '不得把"没有计数"当"零测试"');
});

test('⑧ 非测试命令（tsc --noEmit）：无汇总行 ⇒ 不产生零测试证据（闸门必须放行）', () => {
  const r = TestCountParser.parse('npx tsc --noEmit', '');
  assert.strictEqual(r.runner, 'unknown');
  assert.strictEqual(r.zeroEvidence, false);
  assert.strictEqual(r.total, 0);
});

test('⑨ 空正则捕获组与异常输入不得抛错（解析器要能吞下任何输出）', () => {
  assert.doesNotThrow(() => TestCountParser.parse('', ''));
  assert.doesNotThrow(() => TestCountParser.parse('npm test', '\u0000\uFFFD'.repeat(100)));
  const r = TestCountParser.parse('node --test', '# tests abc');
  assert.strictEqual(r.total, 0, '非数字计数按 0 处理，不抛错');
});

test('⑩ 仪器不得把用例名当读数：TAP 回显的用例名含零测试字样也必须判为"有测试"', () => {
  // 真实形态（本仓实测踩到）：node TAP 会把用例名原样回显，而用例名里就有
  // `no tests ran` / `collected 0 items` 这类字样 ⇒ 曾把「9 个用例全过」误判成「零测试」。
  const tap = [
    '# Subtest: ⑥ pytest：collected 0 items / no tests ran 计为零测试证据',
    'ok 6 - ⑥ pytest：collected 0 items / no tests ran 计为零测试证据',
    '# Subtest: ④ jest：No test files found',
    'ok 7 - ④ jest：No test files found',
    '# tests 9',
    '# pass 9',
    '# fail 0',
  ].join('\n');
  const r = TestCountParser.parse('node --test "dist/tests/unit/testCountParser.test.js"', tap);
  assert.strictEqual(r.zeroEvidence, false, '用例名回显不是零测试证据');
  assert.strictEqual(r.total, 9);
  assert.strictEqual(r.passed, 9);
});

test('⑪ 剔除回显后仍须能识别真正的零测试（真汇总行不能被一并剔掉）', () => {
  const tap = [
    '# Subtest: 某个用例名里带 no test files 字样',
    'ok 1 - 某个用例名里带 no test files 字样',
    '# tests 0',
    '# pass 0',
    '# fail 0',
  ].join('\n');
  const r = TestCountParser.parse('node --test "空 glob"', tap);
  assert.strictEqual(r.zeroEvidence, true, '真汇总行 # tests 0 必须仍然生效');
  assert.strictEqual(r.total, 0);
});

test('⑫ pytest / jest 的逐用例行剔除后，真诊断行仍然生效', () => {
  const pytestReal = ['PASSED tests/test_a.py::test_x', 'collected 0 items'].join('\n');
  assert.strictEqual(TestCountParser.parse('pytest', pytestReal).zeroEvidence, true);

  const pytestEcho = ['PASSED tests/test_a.py::test_no_tests_ran_case', '1 passed in 0.1s'].join(
    '\n',
  );
  const r = TestCountParser.parse('pytest', pytestEcho);
  assert.strictEqual(r.zeroEvidence, false, '用例名里的 no tests ran 不算证据');
  assert.strictEqual(r.passed, 1);
});
