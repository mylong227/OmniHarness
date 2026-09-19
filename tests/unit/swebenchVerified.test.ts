import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SwebenchVerified,
  type ExecutorPort,
  type VerifiedReport,
  type VerifiedResult,
  type VerifiedTask,
} from '../../src/eval/swebenchVerified.js';
import { NativeExecutor } from '../../src/eval/nativeExecutor.js';
import { UvLocator } from '../../src/eval/uvLocator.js';
import { PytestVerdict } from '../../src/eval/pytestVerdict.js';
import { PythonVersionResolver } from '../../src/eval/pythonVersionResolver.js';
import { at } from '../../src/util/arrayAt.js';

/**
 * 写一份最小合法官方 Verified 实例文件，返回路径。
 *
 * 关键：`FAIL_TO_PASS`/`PASS_TO_PASS` 刻意写成**官方 HF 数据集真实的 JSON 字符串形态**
 * （而非数组）——这是回归本次缺陷的核心夹具：旧夹具用数组，从没走过真实形态，故缺陷潜伏。
 * @param path 目标文件路径。
 * @param overrides 覆盖字段（用于构造各类非法/边界实例）。
 */
function writeValid(path: string, overrides: Record<string, unknown> = {}): void {
  const inst = [
    {
      instance_id: 'django__django-1',
      repo: 'django/django',
      base_commit: 'abc123',
      patch: '--- a/x\n+++ b/x\n@@\n-x\n+y\n',
      test_patch: '--- a/t\n+++ b/t\n@@\n',
      FAIL_TO_PASS: JSON.stringify(['x passes']),
      PASS_TO_PASS: JSON.stringify(['y passes']),
      version: '4.2',
      problem_statement: 'fix it',
      ...overrides,
    },
  ];
  writeFileSync(path, JSON.stringify(inst), 'utf8');
}

/** 写一份缺字段的非法官方 Verified 实例文件，返回路径。 */
function writeMalformed(path: string): void {
  writeFileSync(path, JSON.stringify([{ instance_id: 'x' }]), 'utf8');
}

const TASK = (id: string): VerifiedTask => ({
  id,
  repo: 'django/django',
  baseCommit: 'c',
  problemStatement: 'p',
  goldPatch: '',
  testPatch: '',
  failToPass: ['t'],
  passToPass: [],
  version: '4.2',
});

test('loadVerified：合法数据集可被加载（fail-closed 不抛）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sv-'));
  try {
    const p = join(dir, 'ok.json');
    writeValid(p);
    const tasks = SwebenchVerified.loadVerified(p);
    assert.strictEqual(tasks.length, 1);
    const first = at(tasks, 0);
    assert.strictEqual(first.id, 'django__django-1');
    assert.strictEqual(at(first.failToPass, 0), 'x passes');
    assert.strictEqual(at(first.passToPass, 0), 'y passes');
    assert.strictEqual(first.version, '4.2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadVerified：FAIL_TO_PASS 为官方 JSON 字符串时被正确解析（真实数据集形态）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sv-'));
  try {
    const p = join(dir, 'str.json');
    writeValid(p, {
      FAIL_TO_PASS: '["tests/test_x.py::test_a", "tests/test_x.py::test_b"]',
      PASS_TO_PASS: '["tests/test_x.py::test_c"]',
    });
    const tasks = SwebenchVerified.loadVerified(p);
    const first = at(tasks, 0);
    assert.deepEqual([...first.failToPass], ['tests/test_x.py::test_a', 'tests/test_x.py::test_b']);
    assert.deepEqual([...first.passToPass], ['tests/test_x.py::test_c']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadVerified：FAIL_TO_PASS 为空 ⇒ 拒绝加载（fail-open 假绿防线）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sv-'));
  try {
    const p = join(dir, 'empty-f2p.json');
    // 官方字符串 '[]' 与数组 [] 两种形态都必须被拒（空清单 ⇒ [].every 恒真 ⇒ 任何补丁都 resolved）。
    writeValid(p, { FAIL_TO_PASS: '[]' });
    assert.throws(() => SwebenchVerified.loadVerified(p), /FAIL_TO_PASS 为空/);
    writeValid(p, { FAIL_TO_PASS: [] });
    assert.throws(() => SwebenchVerified.loadVerified(p), /FAIL_TO_PASS 为空/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadVerified：PASS_TO_PASS 为空 ⇒ 允许（官方确有 11/500 合规空实例）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sv-'));
  try {
    const p = join(dir, 'empty-p2p.json');
    writeValid(p, { PASS_TO_PASS: '[]' });
    const tasks = SwebenchVerified.loadVerified(p);
    assert.strictEqual(at(tasks, 0).passToPass.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadVerified：测试清单为非法形态（非 JSON 字符串 / 非字符串数组）⇒ 拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sv-'));
  try {
    const p = join(dir, 'badlist.json');
    writeValid(p, { FAIL_TO_PASS: 'not-json' });
    assert.throws(() => SwebenchVerified.loadVerified(p), /非合法 JSON/);
    writeValid(p, { FAIL_TO_PASS: '[1, 2]' }); // JSON 合法但不是字符串数组
    assert.throws(() => SwebenchVerified.loadVerified(p), /须为字符串数组/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NativeExecutor：failToPass 为空 ⇒ 执行边界拒绝判定（纵深防线，不假绿）', async () => {
  const exec = new NativeExecutor();
  const r = await exec.run({ ...TASK('django__django-1'), failToPass: [] }, '--- a\n+++ b\n');
  assert.strictEqual(r.resolved, false);
  assert.match(r.reason ?? '', /FAIL_TO_PASS 为空/);
});

test('loadVerified：缺字段数据集被拒绝（fail-closed 抛错）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sv-'));
  try {
    const p = join(dir, 'bad.json');
    writeMalformed(p);
    assert.throws(() => SwebenchVerified.loadVerified(p), /缺字段/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadVerified：非数组根节点被拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sv-'));
  try {
    const p = join(dir, 'obj.json');
    writeFileSync(p, JSON.stringify({ not: 'array' }), 'utf8');
    assert.throws(() => SwebenchVerified.loadVerified(p), /数组/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NativeExecutor：kind 恒为 native', () => {
  const exec = new NativeExecutor();
  assert.strictEqual(exec.kind, 'native');
  assert.ok(exec.describe().includes('native'));
});

test('NativeExecutor：缺 uv 设施即 fail-closed 返回未通过，且报错指出找过哪些位置', async () => {
  // 注入「找不到 uv」的定位结果：本机 uv 可能装在 ~/.local/bin（不在 PATH 上）也被找到，
  // 依赖真实环境判断会让本用例随机器而变（原先正是如此）。注入后该路径恒被覆盖。
  const exec = new NativeExecutor({
    uvLocator: () => ({ executable: null, searched: ['C:\\nowhere\\uv.exe'] }),
  });
  const r = await exec.run(TASK('django__django-1'), '--- a\n+++ b\n');
  assert.strictEqual(r.resolved, false);
  assert.strictEqual(r.backend, 'native');
  assert.match(r.reason ?? '', /uv 不可用/);
  assert.match(r.reason ?? '', /已查找/, 'fail-closed 必须给出可执行诊断');
  assert.match(r.reason ?? '', /C:\\nowhere\\uv\.exe/, '须列出真实找过的位置');
  assert.match(r.reason ?? '', /OMNI_UV/, '须给出环境变量出口');
});

test('NativeExecutor：缓存根不存在时自动创建（首次真实跑分不再 spawn git ENOENT）', async () => {
  // 需 git + uv 才能走到 clone 步；缺一则跳过（executor 自身亦 fail-closed，见上一例）。
  // uv 判据走定位器而非 PATH：官方安装脚本的落点默认不在 PATH 上（本机实测）。
  if (!SwebenchVerified.commandAvailable('git') || UvLocator.locate().executable === null) return;
  const tmp = mkdtempSync(join(tmpdir(), 'omni-native-'));
  try {
    // 以本地裸仓库作 file:// 远端，隔离网络依赖；只验证「缓存根缺失 ⇒ 自动创建」这一不变量。
    const originBase = join(tmp, 'origin');
    const bare = join(originBase, 'local', 'one.git');
    mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
    const cacheRoot = join(tmp, 'fresh-cache'); // 故意不存在：复现首次运行场景
    const exec = new NativeExecutor({
      repoCacheRoot: cacheRoot,
      repoBaseUrl: `file:///${originBase.replace(/\\/g, '/')}/`,
    });
    // 空仓库的 worktree 步会抛错——与本不变量无关，吞掉即可。
    await exec.run({ ...TASK('local__one-1'), repo: 'local/one' }, '').catch(() => undefined);
    assert.ok(
      existsSync(cacheRoot),
      '缓存根应被自动创建（修复前 clone 以不存在的 cwd 启动 ⇒ spawn git ENOENT）',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('PythonVersionResolver.resolve：精确命中/前缀命中/回落', () => {
  assert.strictEqual(PythonVersionResolver.resolve('django/django', '4.2'), '3.8');
  assert.strictEqual(PythonVersionResolver.resolve('astropy/astropy', '4.3'), '3.9');
  assert.strictEqual(PythonVersionResolver.resolve('astropy/astropy', '4.3.1'), '3.9'); // 前缀
  assert.strictEqual(PythonVersionResolver.resolve('unknown/repo', '9.9'), '3.11'); // 回落
  assert.strictEqual(PythonVersionResolver.resolve('django/django', ''), '3.11'); // 空版本回落
});

test('PythonVersionResolver.degrade：uv 不可 provision 版本回落到最近可用', () => {
  // 3.6/3.7 在 `uv` 分发中已不可得 ⇒ 降级到最近可用的 3.8，避免整题 infra 失败。
  assert.strictEqual(PythonVersionResolver.degrade('3.6'), '3.8');
  assert.strictEqual(PythonVersionResolver.degrade('3.7'), '3.8');
  // 3.8+ 原样返回（uv 可供给）。
  assert.strictEqual(PythonVersionResolver.degrade('3.8'), '3.8');
  assert.strictEqual(PythonVersionResolver.degrade('3.11'), '3.11');
});

test('PythonVersionResolver.resolve：老仓库 3.6/3.7 经降级链落到 3.8', () => {
  // requests 2.26/2.27、pytest 4.6/5.4 等官方口径要求 3.7，但 uv 不可得 ⇒ 经降级得到 3.8。
  assert.strictEqual(PythonVersionResolver.resolve('psf/requests', '2.26'), '3.8');
  assert.strictEqual(PythonVersionResolver.resolve('pytest-dev/pytest', '5.4'), '3.8');
  assert.strictEqual(PythonVersionResolver.resolve('django/django', '2.1'), '3.8'); // 2.1→3.7→3.8
});

test('PytestVerdict.parseResults：PASSED→true，FAILED/ERROR/SKIPPED/缺失→false', () => {
  const output = [
    'tests/test_x.py::test_a PASSED',
    'tests/test_x.py::test_b FAILED',
    'tests/test_x.py::test_c ERROR',
    'tests/test_x.py::test_d SKIPPED',
    'some unrelated line',
  ].join('\n');
  const ids = [
    'tests/test_x.py::test_a',
    'tests/test_x.py::test_b',
    'tests/test_x.py::test_c',
    'tests/test_x.py::test_d',
    'tests/test_x.py::test_e',
  ];
  const r = PytestVerdict.parseResults(output, ids);
  assert.strictEqual(r.get('tests/test_x.py::test_a'), true);
  assert.strictEqual(r.get('tests/test_x.py::test_b'), false);
  assert.strictEqual(r.get('tests/test_x.py::test_c'), false);
  assert.strictEqual(r.get('tests/test_x.py::test_d'), false);
  assert.strictEqual(r.get('tests/test_x.py::test_e'), false); // 缺失 → false
});

test('PytestVerdict.parseResults：裸测试名按叶子名匹配（-rA 摘要形态）', () => {
  // 官方数据集里 sympy/django 等给**裸测试名**，而 pytest 输出是完整 nodeid ⇒ 必须按叶子名比对。
  const output = [
    'PASSED sympy/printing/tests/test_python.py::test_create_expand_pow_optimization',
    'FAILED sympy/printing/tests/test_python.py::test_PythonCodePrinter',
    'PASSED sympy/utilities/tests/test_misc.py::test_empty_modules',
  ].join('\n');
  const ids = [
    'test_create_expand_pow_optimization',
    'test_PythonCodePrinter',
    'test_empty_modules',
    'test_absent',
  ];
  const r = PytestVerdict.parseResults(output, ids);
  assert.strictEqual(r.get('test_create_expand_pow_optimization'), true);
  assert.strictEqual(r.get('test_PythonCodePrinter'), false); // FAILED → false
  assert.strictEqual(r.get('test_empty_modules'), true);
  assert.strictEqual(r.get('test_absent'), false); // 缺失 → false
});

test('PytestVerdict.testFilesOf：抽取 test_patch 的测试文件并过滤非测试文件', () => {
  const patch = [
    'diff --git a/sympy/printing/tests/test_python.py b/sympy/printing/tests/test_python.py',
    '--- a/sympy/printing/tests/test_python.py',
    '+++ b/sympy/printing/tests/test_python.py',
    'diff --git a/conftest.py b/conftest.py',
    '--- a/conftest.py',
    '+++ b/conftest.py',
    '+++ /dev/null',
  ].join('\n');
  assert.deepStrictEqual(
    [...PytestVerdict.testFilesOf(patch)],
    ['sympy/printing/tests/test_python.py'],
  );
  assert.deepStrictEqual([...PytestVerdict.testFilesOf('')], []);
});

test('runVerifiedSuite：默认串行（并发 1）峰值在飞 == 1', async () => {
  const tasks: VerifiedTask[] = [1, 2, 3].map((n) => TASK(`t-${n}`));
  let inFlight = 0;
  let peak = 0;
  const exec: ExecutorPort = {
    kind: 'native',
    async run(task): Promise<VerifiedResult> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { id: task.id, resolved: true, backend: 'native' };
    },
  };
  const predictions = new Map<string, string>([1, 2, 3].map((n) => [`t-${n}`, `patch-${n}`]));
  const report = await SwebenchVerified.runVerifiedSuite(tasks, predictions, exec);
  assert.strictEqual(report.total, 3);
  assert.strictEqual(report.resolved, 3);
  assert.strictEqual(peak, 1); // 串行：任意时刻至多 1 个在飞
});

test('runVerifiedSuite：并发 3 时保序且有界（突破 500 题串行瓶颈）', async () => {
  const tasks: VerifiedTask[] = [1, 2, 3, 4, 5].map((n) => TASK(`t-${n}`));
  const predictions = new Map<string, string>([1, 2, 3, 4, 5].map((n) => [`t-${n}`, `patch-${n}`]));
  let inFlight = 0;
  let peak = 0;
  const exec: ExecutorPort = {
    kind: 'native',
    async run(task): Promise<VerifiedResult> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return { id: task.id, resolved: true, backend: 'native' };
    },
  };
  const report = await SwebenchVerified.runVerifiedSuite(tasks, predictions, exec, 3);
  assert.strictEqual(report.resolved, 5);
  assert.strictEqual(report.total, 5);
  assert.strictEqual(peak, 3); // 有界：不超过并发上限
  assert.deepEqual(
    report.results.map((r) => r.id),
    ['t-1', 't-2', 't-3', 't-4', 't-5'], // 严格同序
  );
});

test('runVerifiedSuite：envError 实例单独计数、不计入 failed 分母', async () => {
  const tasks: VerifiedTask[] = [1, 2, 3].map((n) => TASK(`t-${n}`));
  const predictions = new Map<string, string>([1, 2, 3].map((n) => [`t-${n}`, `patch-${n}`]));
  const exec: ExecutorPort = {
    kind: 'native',
    async run(task): Promise<VerifiedResult> {
      if (task.id === 't-2') {
        return {
          id: task.id,
          resolved: false,
          backend: 'native',
          envError: true,
          reason: 'ENV_BUILD_FAILED: pytest 未装入 venv',
        };
      }
      return { id: task.id, resolved: task.id === 't-1', backend: 'native' };
    },
  };
  const report = await SwebenchVerified.runVerifiedSuite(tasks, predictions, exec);
  assert.strictEqual(report.total, 3);
  assert.strictEqual(report.resolved, 1); // t-1
  assert.strictEqual(report.envErrors, 1); // t-2 环境失败
  assert.strictEqual(report.failed, 1); // t-3 才是真模型失败（t-2 不污染分母）
});

test('formatVerifiedReport：环境失败标 ⚠️ 且有效resolved率排除环境失败', () => {
  const report: VerifiedReport = {
    source: 'official-swebench-verified',
    backend: 'native',
    total: 3,
    resolved: 1,
    failed: 1,
    envErrors: 1,
    results: [
      { id: 't-1', resolved: true, backend: 'native' },
      {
        id: 't-2',
        resolved: false,
        backend: 'native',
        envError: true,
        reason: 'ENV_BUILD_FAILED: pytest 未装入 venv',
      },
      { id: 't-3', resolved: false, backend: 'native' },
    ],
    totalDurationMs: 0,
  };
  const out = SwebenchVerified.formatVerifiedReport(report);
  assert.match(out, /⚠️ t-2/, '环境失败实例应标 ⚠️');
  // 有效 resolved 率 = 1/(3-1) = 50.0%（环境失败不计入分母）
  assert.match(out, /有效resolved率=1\/2=50\.0%/, '有效率应排除环境失败');
  assert.match(out, /环境失败=1/, '应单独列出环境失败数');
});
