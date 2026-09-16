import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SwebenchVerified,
  type ExecutorPort,
  type VerifiedResult,
  type VerifiedTask,
} from '../../src/eval/swebenchVerified.js';
import { NativeExecutor } from '../../src/eval/nativeExecutor.js';
import { PythonVersionResolver } from '../../src/eval/pythonVersionResolver.js';
import { at } from '../../src/util/arrayAt.js';

/** 写一份最小合法官方 Verified 实例文件，返回路径。 */
function writeValid(path: string): void {
  const inst = [
    {
      instance_id: 'django__django-1',
      repo: 'django/django',
      base_commit: 'abc123',
      patch: '--- a/x\n+++ b/x\n@@\n-x\n+y\n',
      test_patch: '--- a/t\n+++ b/t\n@@\n',
      FAIL_TO_PASS: ['x passes'],
      PASS_TO_PASS: ['y passes'],
      version: '4.2',
      problem_statement: 'fix it',
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
  failToPass: [],
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
    assert.strictEqual(first.version, '4.2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('NativeExecutor：缺 uv/git 设施即 fail-closed 返回未通过并写明原因', async () => {
  const exec = new NativeExecutor();
  const r = await exec.run(TASK('django__django-1'), '--- a\n+++ b\n');
  assert.strictEqual(r.resolved, false);
  assert.strictEqual(r.backend, 'native');
  assert.ok((r.reason ?? '').length > 0, 'fail-closed 必须给出原因');
  if (!SwebenchVerified.commandAvailable('uv')) {
    assert.match(r.reason ?? '', /uv/, '沙箱无 uv 时应指明 uv 缺失');
  }
});

test('NativeExecutor：缓存根不存在时自动创建（首次真实跑分不再 spawn git ENOENT）', async () => {
  // 需 git + uv 才能走到 clone 步；缺一则跳过（executor 自身亦 fail-closed，见上一例）。
  if (!SwebenchVerified.commandAvailable('git') || !SwebenchVerified.commandAvailable('uv')) return;
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

test('NativeExecutor.parsePytestResults：PASSED→true，FAILED/ERROR/SKIPPED/缺失→false', () => {
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
  const r = NativeExecutor.parsePytestResults(output, ids);
  assert.strictEqual(r.get('tests/test_x.py::test_a'), true);
  assert.strictEqual(r.get('tests/test_x.py::test_b'), false);
  assert.strictEqual(r.get('tests/test_x.py::test_c'), false);
  assert.strictEqual(r.get('tests/test_x.py::test_d'), false);
  assert.strictEqual(r.get('tests/test_x.py::test_e'), false); // 缺失 → false
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
