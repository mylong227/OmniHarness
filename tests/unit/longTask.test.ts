/**
 * 长任务评测契约判据（P0-2，2026-10-24）。
 *
 * 覆盖：任务清单校验 / pass@k 与 pass^k 口径（复用 AbMetrics）/ 无 key 显式 skip /
 * 隔离临时 git 仓库 / transcript 路径 / 验证失败与超时 / 参考解自检（22 个 fixture 真能跑通）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LongTaskCatalog,
  LongTaskFailureBreakdownCounter,
  LongTaskMetrics,
  LongTaskRunPlan,
  LongTaskSandbox,
  LongTaskSelfCheck,
  LongTaskSessionUsage,
  LongTaskTranscripts,
  LongTaskVerify,
  type LongTaskRun,
  type LongTaskSpec,
} from '../../src/eval/longTaskCatalog.ts';
import { AbMetrics } from '../../src/eval/abMetrics.ts';

/** 真实任务集目录（仓库内 fixture）。 */
const TASKS_DIR = join(process.cwd(), 'tools', 'eval', 'long-tasks');

/** 一个合法的最小任务定义。 */
function validSpec(): Record<string, unknown> {
  return {
    id: 'demo-task',
    prompt: '实现 demo 并运行验证',
    repo: 'demo-task',
    verifyCommand: 'node verify.mjs',
    expectedFiles: ['src/index.js', 'README.md'],
    timeoutMs: 60_000,
    maxTokens: 100_000,
  };
}

/** 建一个假 run（只填 AbRun 需要的字段）。 */
function run(ok: boolean, tokens: number): LongTaskRun {
  return {
    ok,
    tokens,
    wallMs: 1,
    exitCode: 0,
    timedOut: false,
    verifyOk: ok,
    missingFiles: [],
    transcript: 'x.log',
  };
}

test('任务清单：合法通过、缺验收/越界路径/非法时长逐条拒绝', () => {
  const ok = LongTaskCatalog.validate(validSpec());
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.spec?.id, 'demo-task');

  const noVerify = { ...validSpec(), verifyCommand: '' };
  const noVerifyResult = LongTaskCatalog.validate(noVerify);
  assert.strictEqual(noVerifyResult.ok, false);
  assert.match(noVerifyResult.errors.join('\n'), /verifyCommand/u);

  const traversal = { ...validSpec(), expectedFiles: ['../etc/passwd'] };
  const traversalResult = LongTaskCatalog.validate(traversal);
  assert.strictEqual(traversalResult.ok, false);
  assert.match(traversalResult.errors.join('\n'), /越界\/绝对路径/u);

  const badTimeout = { ...validSpec(), timeoutMs: 0 };
  assert.strictEqual(LongTaskCatalog.validate(badTimeout).ok, false);
  const emptyFiles = { ...validSpec(), expectedFiles: [] };
  assert.strictEqual(LongTaskCatalog.validate(emptyFiles).ok, false);
  assert.strictEqual(
    LongTaskCatalog.validate({ ...validSpec(), expectedFiles: ['/abs/x'] }).ok,
    false,
  );

  const unknown = LongTaskRunPlan.parseArgs(['--only', 'nope'], { tasksDir: TASKS_DIR });
  assert.throws(
    () => LongTaskCatalog.filter(LongTaskCatalog.load(TASKS_DIR), unknown.only),
    /未知任务 id/u,
  );
});

test('仓库内 40 个任务可加载，且 fixture / verifier / 参考解齐全', () => {
  const specs = LongTaskCatalog.load(TASKS_DIR);
  assert.strictEqual(specs.length, 40);
  assert.strictEqual(new Set(specs.map((spec) => spec.id)).size, 40, '任务 id 必须唯一');
  for (const spec of specs) {
    assert.ok(existsSync(join(TASKS_DIR, 'fixtures', spec.repo, 'src', 'index.js')), spec.id);
    assert.ok(existsSync(join(TASKS_DIR, 'verifiers', `${spec.id}.mjs`)), spec.id);
    assert.ok(existsSync(join(TASKS_DIR, 'solutions', `${spec.id}.js`)), spec.id);
    assert.ok(existsSync(join(TASKS_DIR, 'solutions', `${spec.id}.README.md`)), spec.id);
    assert.ok(spec.expectedFiles.includes('README.md'), '每个任务都要求 README.md');
  }
});

test('口径：pass@k / pass^k 与 tokensPerSolved 复用 AbMetrics（不复制公式）', () => {
  const tasks = [
    { id: 'a', runs: [run(true, 100), run(true, 100)] },
    { id: 'b', runs: [run(true, 200), run(false, 200)] },
  ];
  const aggregate = LongTaskMetrics.aggregate(tasks);
  assert.strictEqual(aggregate.tasks, 2);
  assert.strictEqual(aggregate.runs, 4);
  assert.strictEqual(aggregate.successes, 3);
  assert.strictEqual(aggregate.passAt1, 0.75);
  assert.strictEqual(aggregate.passAtK, 1, '两个任务至少成功一次');
  assert.strictEqual(aggregate.passAllK, 0.5, '只有任务 a 全成功');
  assert.strictEqual(
    aggregate.tokensPerSolved,
    AbMetrics.summarize([run(true, 100), run(true, 100), run(true, 200), run(false, 200)])
      .tokensPerSolved,
    'token 口径必须与 AbMetrics 同源',
  );
  const perTask = LongTaskMetrics.summarizeTask(tasks[1]?.runs ?? []);
  assert.strictEqual(perTask.passAllK, false);
  assert.deepStrictEqual(LongTaskMetrics.aggregate([]), {
    tasks: 0,
    runs: 0,
    successes: 0,
    passAt1: 0,
    passAtK: 0,
    passAllK: 0,
    tokens: 0,
    tokensPerSolved: null,
    wallMs: 0,
  });
});

test('失败模式拆解：超时/验收失败/缺文件/非零退出独立计数', () => {
  const report = LongTaskFailureBreakdownCounter.summarize([
    {
      runs: [
        {
          ok: false,
          tokens: 10,
          wallMs: 1,
          exitCode: 1,
          timedOut: true,
          verifyOk: false,
          missingFiles: ['README.md'],
          transcript: 'a.log',
        },
        {
          ok: false,
          tokens: 10,
          wallMs: 1,
          exitCode: 0,
          timedOut: false,
          verifyOk: false,
          missingFiles: [],
          transcript: 'b.log',
        },
        {
          ok: true,
          tokens: 10,
          wallMs: 1,
          exitCode: 0,
          timedOut: false,
          verifyOk: true,
          missingFiles: [],
          transcript: 'c.log',
        },
      ],
    },
  ]);
  assert.deepStrictEqual(report, {
    runs: 3,
    failed: 2,
    timedOut: 1,
    verifyFailed: 2,
    missingFiles: 1,
    nonzeroExit: 1,
  });
});

test('无 key：显式 skipped 理由（不 mock 冒充），有 key 时不跳过', () => {
  const reason = LongTaskRunPlan.skipReason({});
  assert.ok(reason !== undefined && reason.includes('OMNIHARNESS_API_KEY'), '必须点明缺哪个 key');
  assert.ok(reason !== undefined && reason.includes('skipped'));
  assert.strictEqual(LongTaskRunPlan.skipReason({ OMNIHARNESS_API_KEY: '  ' }), reason);
  assert.strictEqual(LongTaskRunPlan.skipReason({ OMNIHARNESS_API_KEY: 'sk-test' }), undefined);
});

test('隔离：同 fixture 的两个沙箱互不影响，且各自是独立 git 仓库', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-longtask-sandbox-'));
  try {
    const specs = LongTaskCatalog.load(TASKS_DIR);
    const spec = specs[0] as LongTaskSpec;
    const first = LongTaskSandbox.materialize({
      spec,
      fixturesRoot: join(TASKS_DIR, 'fixtures'),
      rootDir: root,
    });
    const second = LongTaskSandbox.materialize({
      spec,
      fixturesRoot: join(TASKS_DIR, 'fixtures'),
      rootDir: root,
    });
    assert.notStrictEqual(first.dir, second.dir);
    assert.strictEqual(first.git, true);
    assert.ok(existsSync(join(first.dir, '.git')), '必须是独立 git 仓库');
    writeFileSync(join(first.dir, 'README.md'), 'first only', 'utf8');
    assert.ok(!existsSync(join(second.dir, 'README.md')), '第二个沙箱不得看到第一个的写入');
    const fixtureSource = readFileSync(
      join(TASKS_DIR, 'fixtures', spec.repo, 'src', 'index.js'),
      'utf8',
    );
    assert.ok(
      fixtureSource.includes('not implemented'),
      'fixture 本体必须保持 stub（不被跑测污染）',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transcript：按 task/run 落盘并回传绝对路径', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-longtask-transcript-'));
  try {
    const transcripts = new LongTaskTranscripts(join(root, 'nested', 'logs'));
    const path = transcripts.write('demo-task', 1, 'hello transcript');
    assert.ok(path.startsWith(transcripts.dir), '路径必须落在 transcript 目录内');
    assert.match(path, /demo-task__run2\.log$/u);
    assert.strictEqual(readFileSync(path, 'utf8'), 'hello transcript');
    assert.ok(existsSync(transcripts.dir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('验证：失败退出码 / 超时 / 通过三态分明（超时不当作通过）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-longtask-verify-'));
  try {
    const failed = await LongTaskVerify.run(
      { verifyCommand: 'node -e "process.exit(3)"', timeoutMs: 10_000 },
      root,
    );
    assert.strictEqual(failed.ran, true);
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.exitCode, 3);
    assert.strictEqual(failed.command, 'node -e "process.exit(3)"');

    const timedOut = await LongTaskVerify.run(
      { verifyCommand: 'node -e "setTimeout(() => {}, 5000)"', timeoutMs: 400 },
      root,
    );
    assert.strictEqual(timedOut.timedOut, true);
    assert.strictEqual(timedOut.ok, false);

    const passed = await LongTaskVerify.run(
      { verifyCommand: 'node -e "process.exit(0)"', timeoutMs: 10_000 },
      root,
    );
    assert.strictEqual(passed.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('token 读取：只累加 model usage，坏行跳过', () => {
  const jsonl = [
    JSON.stringify({ type: 'model', payload: { usage: { totalTokens: 10 } } }),
    'not json',
    JSON.stringify({ type: 'tool_call', payload: {} }),
    JSON.stringify({ type: 'model', payload: { usage: { totalTokens: 5 } } }),
    '',
  ].join('\n');
  assert.strictEqual(LongTaskSessionUsage.tokensOfJsonl(jsonl), 15);
  assert.strictEqual(LongTaskSessionUsage.tokensOfJsonl(''), 0);
  assert.strictEqual(LongTaskSessionUsage.read('/nonexistent', 'sess'), 0);
});

test('自检：40 个参考解全部通过各自验证器（任务本身可解）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-longtask-selfcheck-'));
  try {
    const report = await LongTaskSelfCheck.run({
      specs: LongTaskCatalog.load(TASKS_DIR),
      tasksDir: TASKS_DIR,
      rootDir: root,
    });
    assert.strictEqual(report.failed, 0, JSON.stringify(report.items.filter((item) => !item.ok)));
    assert.strictEqual(report.passed, 40);
    assert.strictEqual(report.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 参数：k/model/dry-run/self-check/only 解析，未知旗标 fail-closed', () => {
  const options = LongTaskRunPlan.parseArgs(
    ['--k', '3', '--model', 'demo-model', '--dry-run', '--only', 'a,b', '--out=report.json'],
    { tasksDir: TASKS_DIR },
  );
  assert.strictEqual(options.k, 3);
  assert.strictEqual(options.model, 'demo-model');
  assert.strictEqual(options.dryRun, true);
  assert.deepStrictEqual(options.only, ['a', 'b']);
  assert.strictEqual(options.out, 'report.json');
  assert.strictEqual(options.selfCheck, false);
  assert.strictEqual(options.longHorizon, false);
  // 预算倍率：缺省 1（与任务规格同口径）；显式放大用于敏感性对照。
  assert.strictEqual(options.timeoutScale, 1);
  assert.strictEqual(
    LongTaskRunPlan.parseArgs(['--timeout-scale', '2'], { tasksDir: TASKS_DIR }).timeoutScale,
    2,
  );
  assert.throws(() => LongTaskRunPlan.parseArgs(['--nope'], { tasksDir: TASKS_DIR }), /未知参数/u);
  assert.throws(() => LongTaskRunPlan.parseArgs(['--k', '0'], { tasksDir: TASKS_DIR }), /--k/u);
  for (const bad of ['0', '-1', '11', 'abc', '']) {
    assert.throws(
      () => LongTaskRunPlan.parseArgs(['--timeout-scale', bad], { tasksDir: TASKS_DIR }),
      /--timeout-scale/u,
      `timeout-scale=${bad} 应被拒`,
    );
  }
  // dry-run 报告要带上倍率（避免把放宽预算的数字误读成基准口径）。
  const plan = LongTaskRunPlan.dryRunReport(
    LongTaskRunPlan.parseArgs(['--timeout-scale', '2', '--dry-run'], { tasksDir: TASKS_DIR }),
    [],
  );
  assert.strictEqual(plan.timeoutScale, 2);
});
