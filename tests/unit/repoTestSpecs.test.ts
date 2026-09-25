/**
 * per-repo 测试规格的纯函数单测（看板 §21.17 的修复件）。
 *
 * 背景：判分主链路此前对所有仓库统一用 `pytest <test_patch 文件> -rA`，而官方 harness 对 django 用
 * `./tests/runtests.py --settings=test_sqlite <dotted directives>` 且结果行是 unittest 风格（走 stderr）
 * ⇒ 通用路径对 django 恒判「未通过」（gold 对照实测 14 题全败）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepoTestSpecs } from '../../src/eval/repoTestSpecs.js';

test('djangoDirectiveOf：数据集口径 `test_x (module.Class)` → 点分 directive', () => {
  assert.strictEqual(
    RepoTestSpecs.djangoDirectiveOf(
      'test_memoryview_content (httpwrappers.tests.HttpResponseTests)',
    ),
    'httpwrappers.tests.HttpResponseTests.test_memoryview_content',
  );
});

test('djangoDirectiveOf：已是点分形式原样透传；括号内已含方法名时不重复拼接', () => {
  assert.strictEqual(
    RepoTestSpecs.djangoDirectiveOf('httpwrappers.tests.HttpResponseTests.test_x'),
    'httpwrappers.tests.HttpResponseTests.test_x',
  );
  assert.strictEqual(
    RepoTestSpecs.djangoDirectiveOf('test_x (httpwrappers.tests.HttpResponseTests.test_x)'),
    'httpwrappers.tests.HttpResponseTests.test_x',
  );
});

test('parseDjango：ok/FAIL/ERROR/skipped/缺失 → 通过 / 未通过（fail-closed）', () => {
  const ids = [
    'test_a (mod.ClassA)',
    'test_b (mod.ClassA)',
    'test_c (mod.ClassB)',
    'test_d (mod.ClassB)',
    'test_e (mod.ClassC)',
  ] as const;
  const output = [
    'test_a (mod.ClassA) ... ok',
    'test_b (mod.ClassA) ... FAIL',
    'test_c (mod.ClassB) ... ERROR',
    'test_d (mod.ClassB) ... skipped "no db"',
    'Ran 4 tests in 0.123s',
  ].join('\n');
  const passed = RepoTestSpecs.parseDjango(output, ids);
  assert.strictEqual(passed.get(ids[0]), true, 'ok ⇒ 通过');
  assert.strictEqual(passed.get(ids[1]), false, 'FAIL ⇒ 未通过');
  assert.strictEqual(passed.get(ids[2]), false, 'ERROR ⇒ 未通过');
  assert.strictEqual(passed.get(ids[3]), false, 'skipped ⇒ 未通过（与 pytest 路径同口径）');
  assert.strictEqual(passed.get(ids[4]), false, '输出里没出现 ⇒ 未通过（fail-closed）');
});

test('parseDjango：同一测试多行出现时以最后一次为准', () => {
  const ids = ['test_x (mod.ClassA)'] as const;
  const output = ['test_x (mod.ClassA) ... FAIL', 'test_x (mod.ClassA) ... ok'].join('\n');
  assert.strictEqual(RepoTestSpecs.parseDjango(output, ids).get(ids[0]), true);
});

test('parseDjango：**真实输出**的两种形态混用——双行 docstring 的「裸展示名」id 必须对上', () => {
  // 逐字取自 eval-data/_dj_probe_django__django-11133.log（django 3.0 + `--verbosity 2`）：
  // 无 docstring 的测试是单行；有 docstring 的测试是**双行**（`getDescription()` 返回 `str(test)\n<docstring 首行>`
  // ⇒ 状态词落在第二行）。数据集里那 8/65 个「裸展示名」id 正是第二行去掉 ` ... ok` 的形态。
  const output = [
    'Testing against Django installed in ...',
    'test_cookie_edgecases (httpwrappers.tests.CookieTests) ... ok',
    'test_decode (httpwrappers.tests.CookieTests)',
    'Semicolons and commas are decoded. ... ok',
    'test_invalid_redirect_repr (httpwrappers.tests.HttpResponseSubclassesTests)',
    'If HttpResponseRedirect raises DisallowedRedirect, its __repr__() ... ok',
    'test_httponly_after_load (httpwrappers.tests.CookieTests) ... ok',
    'Ran 4 tests in 0.011s',
    'OK',
  ].join('\n');
  const ids = [
    'Semicolons and commas are decoded.', // 裸展示名（双行形态第二行）
    'test_cookie_edgecases (httpwrappers.tests.CookieTests)', // 单行形态原文
    'test_decode (httpwrappers.tests.CookieTests)', // 双行形态的第一行
    'If HttpResponseRedirect raises DisallowedRedirect, its __repr__()', // 裸展示名（含括号，必须不被误当 `名 (类)`）
    'test_memoryview_content (httpwrappers.tests.HttpResponseTests)', // 输出里没有 ⇒ fail-closed
  ] as const;
  const passed = RepoTestSpecs.parseDjango(output, ids);
  assert.strictEqual(passed.get(ids[0]), true, '裸展示名须由双行形态的第二行命中');
  assert.strictEqual(passed.get(ids[1]), true, '单行形态原文命中');
  assert.strictEqual(
    passed.get(ids[2]),
    true,
    '双行形态的第一行也须登记（无 docstring 时它就是结果行）',
  );
  assert.strictEqual(passed.get(ids[3]), true, '展示名自带括号时不能被切成 `展示名 (类)`');
  assert.strictEqual(passed.get(ids[4]), false, '未出现 ⇒ 未通过（fail-closed）');
});

test('parseDjango：docstring 展示名（含空格）也能对上——类级 directive + 展示名 id 原文双索引', () => {
  const ids = ['Semicolons and commas are decoded (httpwrappers.tests.QueryDictTests)'] as const;
  const output = [
    'Semicolons and commas are decoded (httpwrappers.tests.QueryDictTests) ... ok',
  ].join('\n');
  const passed = RepoTestSpecs.parseDjango(output, ids);
  assert.strictEqual(passed.get(ids[0]), true, 'docstring 展示名走「原样 id」索引');
  // 展示名非合法标识符 ⇒ directive 退到类级（否则拼出的 `类.带空格展示名` 无法导入，实测 35/65 全 ERROR）
  assert.strictEqual(
    RepoTestSpecs.djangoDirectiveOf(ids[0]),
    'httpwrappers.tests.QueryDictTests',
    '非标识符展示名须退到类级 directive',
  );
});

test('djangoModuleDirectivesOf：从 test_patch 推出模块 directive（官方 harness 的做法）', () => {
  const patch = [
    'diff --git a/tests/httpwrappers/tests.py b/tests/httpwrappers/tests.py',
    '--- a/tests/httpwrappers/tests.py',
    '+++ b/tests/httpwrappers/tests.py',
    '@@ -1 +1 @@',
    'diff --git a/django/http/response.py b/django/http/response.py',
  ].join('\n');
  assert.deepStrictEqual(RepoTestSpecs.djangoModuleDirectivesOf(patch), ['httpwrappers.tests']);
});

test('argsOf：django 命令走 test_patch 推出的模块（而非把 id 当模块名导入）', () => {
  const spec = RepoTestSpecs.django();
  const ctx = {
    testPatch: 'diff --git a/tests/httpwrappers/tests.py b/tests/httpwrappers/tests.py\n',
  };
  assert.deepStrictEqual(
    spec.argsOf(['Semicolons and commas are decoded (httpwrappers.tests.QueryDictTests)'], ctx),
    [
      './tests/runtests.py',
      '--verbosity',
      '2',
      '--settings=test_sqlite',
      '--parallel',
      '1',
      'httpwrappers.tests',
    ],
  );
});

test('for：默认关闭（回落既有 pytest 路径）；OMNI_REPO_TEST_SPECS=1 时才启用 django 专属规格', () => {
  const prev = process.env['OMNI_REPO_TEST_SPECS'];
  try {
    delete process.env['OMNI_REPO_TEST_SPECS'];
    assert.strictEqual(RepoTestSpecs.for('django/django'), null, '默认零行为变更');
    process.env['OMNI_REPO_TEST_SPECS'] = '1';
    assert.strictEqual(RepoTestSpecs.for('django/django')?.label.includes('runtests.py'), true);
    assert.strictEqual(RepoTestSpecs.for('sympy/sympy'), null, '未登记仓库始终 null');
    assert.strictEqual(RepoTestSpecs.for('astropy/astropy'), null);
  } finally {
    if (prev === undefined) delete process.env['OMNI_REPO_TEST_SPECS'];
    else process.env['OMNI_REPO_TEST_SPECS'] = prev;
  }
});
