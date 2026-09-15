/**
 * B2 Terminal-Bench 适配器单测（stub，无 docker）。
 *
 * 覆盖：TaskParser 解析、GrepBaselineSolver 预算纪律、TerminalBenchRunner 端到端计分。
 * 真实任务隔离（docker 后端）与真实 Agent 运行时不在此测试，待本机 docker 环境出数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  CommandOutcome,
  ContainerBackend,
  Solver,
  SolverOutcome,
  TerminalBenchTask,
} from '../../src/benchmark/terminalbench/types.js';
import { TaskParser } from '../../src/benchmark/terminalbench/taskParser.js';
import { GrepBaselineSolver } from '../../src/benchmark/terminalbench/grepBaselineSolver.js';
import { OmniSolver } from '../../src/benchmark/terminalbench/omniSolver.js';
import { TerminalBenchRunner } from '../../src/benchmark/terminalbench/terminalBenchRunner.js';

/** 写一个最小 Terminal-Bench 任务目录（task.yaml + run-tests.sh + 可选 setup.sh）。 */
function makeTaskDir(root: string, name: string, withSetup: boolean): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'task.yaml'),
    `name: ${name}\nauthor: test\ncategories:\n  - demo\ndifficulty: easy\n`,
  );
  writeFileSync(join(dir, 'solution.sh'), '#!/bin/bash\necho ok\n');
  writeFileSync(join(dir, 'run-tests.sh'), '#!/bin/bash\nexit 0\n');
  if (withSetup) {
    writeFileSync(join(dir, 'setup.sh'), '#!/bin/bash\necho setup\n');
  }
  return dir;
}

/** 假后端：所有命令即时返回；可由 failTest 控制 run-tests.sh 的退出码。 */
class FakeBackend implements ContainerBackend {
  /** 后端种类标识（固定 local）。 */
  public readonly kind = 'local' as const;
  /** runCommand 调用计数（测试断言用）。 */
  public calls = 0;
  /** 置 true 时令 run-tests.sh 退出 1。 */
  public failTest = false;
  /**
   * 即时返回一条命令结果。
   *
   * @param cmd 命令与参数（argv 数组）
   * @param _workdir 工作目录（本 stub 忽略）
   * @returns 固定退出码与伪输出
   */
  public runCommand(cmd: readonly string[], _workdir: string): Promise<CommandOutcome> {
    this.calls += 1;
    const isTest = cmd[1] !== undefined && cmd[1].includes('run-tests.sh');
    const exitCode = isTest && this.failTest ? 1 : 0;
    return Promise.resolve({ exitCode, stdout: 'fake', stderr: '' });
  }
}

/** 假 Solver：消耗 1 次预算，产出固定答案。 */
class FakeSolver implements Solver {
  /** Solver 名称（固定 fake）。 */
  public readonly name = 'fake';
  /** solve 调用计数（测试断言用）。 */
  public calls = 0;
  /**
   * 消耗 1 次预算并返回固定答案。
   *
   * @param _task 任务（本 stub 忽略）
   * @param _backend 容器后端（本 stub 忽略）
   * @returns 固定答案与消耗次数
   */
  public async solve(_task: TerminalBenchTask, _backend: ContainerBackend): Promise<SolverOutcome> {
    this.calls += 1;
    return { answer: 'fake-answer', budgetUsed: 1 };
  }
}

test('TaskParser 解析扁平 task.yaml（含分类列表）', () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-parse-'));
  const dir = makeTaskDir(root, 'alpha', true);
  const task = TaskParser.parse(dir);
  assert.strictEqual(task.name, 'alpha');
  assert.strictEqual(task.author, 'test');
  assert.strictEqual(task.difficulty, 'easy');
  assert.deepStrictEqual([...task.categories], ['demo']);
  assert.ok(task.testScript.endsWith('run-tests.sh'));
  assert.ok(task.setupScript !== null && task.setupScript.endsWith('setup.sh'));
});

test('TaskParser 缺 task.yaml 即 fail-closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-missing-'));
  const dir = join(root, 'nobody');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run-tests.sh'), 'exit 0\n');
  assert.throws(() => TaskParser.parse(dir), /task\.yaml/);
});

test('GrepBaselineSolver 严守预算（不多于 maxToolCalls）', async () => {
  const backend = new FakeBackend();
  const solver = GrepBaselineSolver.create();
  const task = TaskParser.parse(
    makeTaskDir(mkdtempSync(join(tmpdir(), 'tb-grep-')), 'beta', false),
  );
  const out = await solver.solve(task, backend, { maxToolCalls: 2, maxDurationMs: 1000 });
  assert.ok(out.budgetUsed <= 2, '预算不得超限');
  assert.ok(backend.calls <= 2, '后端调用不得超预算');
});

test('TerminalBenchRunner 端到端计分（全通过）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-run-'));
  makeTaskDir(root, 't1', false);
  makeTaskDir(root, 't2', true);
  const backend = new FakeBackend();
  const solver = new FakeSolver();
  const report = await TerminalBenchRunner.run({
    tasksRoot: root,
    backend,
    solver,
    budget: { maxToolCalls: 8, maxDurationMs: 600000 },
    reportPath: join(root, 'report.json'),
  });
  assert.strictEqual(report.total, 2);
  assert.strictEqual(report.passed, 2);
  assert.strictEqual(report.passRate, 1);
  assert.strictEqual(solver.calls, 2);
});

test('TerminalBenchRunner 判分失败（run-tests.sh 退出 1）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-fail-'));
  makeTaskDir(root, 'bad', false);
  const backend = new FakeBackend();
  backend.failTest = true;
  const solver = new FakeSolver();
  const report = await TerminalBenchRunner.run({
    tasksRoot: root,
    backend,
    solver,
    budget: { maxToolCalls: 8, maxDurationMs: 600000 },
    reportPath: join(root, 'report.json'),
  });
  assert.strictEqual(report.total, 1);
  assert.strictEqual(report.passed, 0);
  assert.strictEqual(report.results[0]!.passed, false);
  assert.ok(report.results[0]!.error !== null);
});

test('OmniSolver 经注入接缝求解（沙箱无真实 Agent 时 fail-closed）', async () => {
  const injected = OmniSolver.create(async () => ({ answer: 'agent-answer', budgetUsed: 3 }));
  const out = await injected.solve(
    TaskParser.parse(makeTaskDir(mkdtempSync(join(tmpdir(), 'tb-omni-')), 'g', false)),
    new FakeBackend(),
    { maxToolCalls: 8, maxDurationMs: 600000 },
  );
  assert.strictEqual(out.answer, 'agent-answer');
  assert.strictEqual(out.budgetUsed, 3);

  const noRunner = OmniSolver.create((() => {
    throw new Error('no runner');
  }) as never);
  await assert.rejects(() =>
    noRunner.solve(
      TaskParser.parse(makeTaskDir(mkdtempSync(join(tmpdir(), 'tb-omni2-')), 'g2', false)),
      new FakeBackend(),
      { maxToolCalls: 8, maxDurationMs: 600000 },
    ),
  );
});
