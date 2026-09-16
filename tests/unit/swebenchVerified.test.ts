import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SwebenchVerified,
  LocalDockerExecutor,
  ModalExecutor,
  type ExecutorOptions,
  type ExecutorPort,
  type VerifiedResult,
  type VerifiedTask,
} from '../../src/eval/swebenchVerified.js';
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
      version: '1.0',
      problem_statement: 'fix it',
    },
  ];
  writeFileSync(path, JSON.stringify(inst), 'utf8');
}

/** 写一份缺字段的非法官方 Verified 实例文件，返回路径。 */
function writeMalformed(path: string): void {
  writeFileSync(path, JSON.stringify([{ instance_id: 'x' }]), 'utf8');
}

const EXEC_OPTS: ExecutorOptions = {
  modelName: 'deepseek-chat',
  modelApiBase: 'https://api.deepseek.com',
  modelApiKey: '',
};

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

test('parseResolved：容忍对象形态与数组形态，缺失返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sv-'));
  try {
    // 对象形态
    writeFileSync(
      join(dir, 'report.json'),
      JSON.stringify({ 'django__django-1': { resolved: true } }),
      'utf8',
    );
    assert.strictEqual(SwebenchVerified.parseResolved(dir, 'django__django-1'), true);
    assert.strictEqual(SwebenchVerified.parseResolved(dir, 'missing'), null);
    // 数组形态（覆盖同目录 report.json）
    writeFileSync(
      join(dir, 'report.json'),
      JSON.stringify([{ instance_id: 'django__django-1', resolved: false }]),
      'utf8',
    );
    assert.strictEqual(SwebenchVerified.parseResolved(dir, 'django__django-1'), false);
    // 不存在的输出目录
    assert.strictEqual(SwebenchVerified.parseResolved(join(dir, 'nope'), 'x'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LocalDockerExecutor：缺设施即 fail-closed 返回未通过并写明原因', async () => {
  const exec = new LocalDockerExecutor(EXEC_OPTS);
  assert.strictEqual(exec.kind, 'docker');
  const r = await exec.run('django__django-1', '--- a\n+++ b\n');
  assert.strictEqual(r.resolved, false);
  assert.ok((r.reason ?? '').length > 0, 'fail-closed 必须给出原因');
});

test('ModalExecutor：沙箱无 modal CLI → fail-closed 返回未通过并写明原因', async () => {
  const exec = new ModalExecutor(EXEC_OPTS);
  assert.strictEqual(exec.kind, 'modal');
  const r = await exec.run('django__django-1', '--- a\n+++ b\n');
  assert.strictEqual(r.resolved, false);
  assert.match(r.reason ?? '', /modal/);
});

test('runVerifiedSuite：默认串行（并发 1）峰值在飞 == 1', async () => {
  const tasks: VerifiedTask[] = [1, 2, 3].map((n) => ({
    id: `t-${n}`,
    repo: 'r/r',
    baseCommit: 'c',
    problemStatement: 'p',
    goldPatch: '',
    testPatch: '',
    failToPass: [],
    passToPass: [],
  }));
  let inFlight = 0;
  let peak = 0;
  const exec: ExecutorPort = {
    kind: 'modal',
    async run(id: string): Promise<VerifiedResult> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { id, resolved: true, backend: 'modal' };
    },
  };
  const predictions = new Map<string, string>([1, 2, 3].map((n) => [`t-${n}`, `patch-${n}`]));
  const report = await SwebenchVerified.runVerifiedSuite(tasks, predictions, exec);
  assert.strictEqual(report.total, 3);
  assert.strictEqual(report.resolved, 3);
  assert.strictEqual(peak, 1); // 串行：任意时刻至多 1 个在飞
});

test('runVerifiedSuite：并发 3 时保序且有界（突破 500 题串行瓶颈）', async () => {
  const tasks: VerifiedTask[] = [1, 2, 3, 4, 5].map((n) => ({
    id: `t-${n}`,
    repo: 'r/r',
    baseCommit: 'c',
    problemStatement: 'p',
    goldPatch: '',
    testPatch: '',
    failToPass: [],
    passToPass: [],
  }));
  const predictions = new Map<string, string>([1, 2, 3, 4, 5].map((n) => [`t-${n}`, `patch-${n}`]));
  let inFlight = 0;
  let peak = 0;
  const exec: ExecutorPort = {
    kind: 'modal',
    async run(id: string): Promise<VerifiedResult> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return { id, resolved: true, backend: 'modal' };
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
