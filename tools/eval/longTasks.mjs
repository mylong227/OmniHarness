#!/usr/bin/env node
/**
 * 长任务评测跑分器（`npm run eval:long`，2026-10-24 P0-2）。
 *
 * 回答的问题：**同一模型、同一长任务集，harness 的长时程能力（结构化进度 / 收尾检查清单）
 * 是否真的改变 pass@k / pass^k / tokens-per-solved**。
 *
 * 用法：
 *   npm run build
 *   node tools/eval/longTasks.mjs --dry-run
 *   node tools/eval/longTasks.mjs --self-check
 *   node tools/eval/longTasks.mjs --k 3 --model <model> --out report.json
 *   node tools/eval/longTasks.mjs --k 3 --long-horizon --only strings-basic,arrays-basic
 *
 * 判据口径：
 *  - **复用** `src/eval/abMetrics.ts`（dist）的 `AbMetrics`：pass@k / pass^k / tokensPerSolved 不复制公式；
 *  - 每任务每次运行都在**独立临时 git 仓库**里（fixture 复制、git init + commit），互不污染；
 *  - 验收 = CLI 退出 0 + `ok:true` + `verifyCommand` 通过 + `expectedFiles` 齐全；
 *  - `verify.mjs` 在验收前从 `verifiers/` **覆盖写入**，模型对它的修改不算数；
 *  - 无 `OMNIHARNESS_API_KEY` 时输出 `{skipped:true}` 并以 0 退出——**不用 mock 冒充真实跑分**；
 *  - 每次运行写一份 transcript（stdout/stderr/验证输出），报告里回传路径。
 *
 * `--long-horizon` 会显式设置 `OMNI_LONG_HORIZON=1` + `OMNI_LONG_HORIZON_TASK/VERIFY`；
 * 不加时显式设置 `OMNI_LONG_HORIZON=0`（基线对照，避免复杂 prompt 自动开启污染 A/B）。
 *
 * 诚实边界：20 个 fixture 是**本仓自建的合成任务**（不是 SWE-bench / Terminal-Bench 分数）；
 * token 来自模型 usage，端点不回传 usage 时为 0（不臆造估算）；单次小差异不可作为收益结论。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'dist', 'src', 'cli', 'exec.js');
const LONG_TASK_MODULE = join(ROOT, 'dist', 'src', 'eval', 'longTaskCatalog.js');
const DEFAULT_TASKS_DIR = join(ROOT, 'tools', 'eval', 'long-tasks');
const MAX_TRANSCRIPT_STDOUT = 200_000;

/** 读取 dist 模块（缺构建产物时给出可执行提示）。 */
async function loadModules() {
  if (!existsSync(LONG_TASK_MODULE) || !existsSync(CLI)) {
    throw new Error('缺少 dist；先运行 npm run build');
  }
  return import(pathToFileURL(LONG_TASK_MODULE).href);
}

/** 默认 transcript 目录：`--out` 旁边，否则仓库 gitignored 的 `.tmp/` 下（不会入库）。 */
function transcriptsDirOf(options, runId) {
  if (options.transcriptsDir !== undefined) return resolve(options.transcriptsDir);
  if (options.out !== undefined) {
    return join(dirname(resolve(options.out)), '.long-task-transcripts', runId);
  }
  return join(ROOT, '.tmp', 'long-task-transcripts', runId);
}

/** 组装一次 CLI 调用的参数（模型/预算/token 上限均透传）。 */
function cliArgsOf(spec, workspace, store, model) {
  const args = [
    CLI,
    '--print',
    '--prompt',
    spec.prompt,
    '--output-format',
    'json',
    '--approval',
    'auto',
    '--workspace',
    workspace,
    '--storage-adapter',
    'jsonl',
    '--storage-dir',
    store,
    '--turn-token-budget',
    String(spec.maxTokens),
  ];
  if (model !== undefined) args.push('--model', model);
  return args;
}

/** 组装子进程环境：显式开关长时程协议（基线 = '0'，不靠复杂度自动判定污染对照）。 */
function envOf(options, spec) {
  const env = { ...process.env, OMNI_LONG_HORIZON: options.longHorizon ? '1' : '0' };
  if (options.longHorizon) {
    env.OMNI_LONG_HORIZON_TASK = spec.id;
    env.OMNI_LONG_HORIZON_VERIFY = spec.verifyCommand;
  } else {
    delete env.OMNI_LONG_HORIZON_TASK;
    delete env.OMNI_LONG_HORIZON_VERIFY;
  }
  return env;
}

/** 解析 CLI stdout（非 JSON 时保留原文摘要，不假装成功）。 */
function parsedJson(stdout) {
  try {
    const parsed = JSON.parse(String(stdout).trim());
    return typeof parsed === 'object' && parsed !== null
      ? parsed
      : { ok: false, error: 'stdout 不是对象' };
  } catch {
    return { ok: false, error: 'stdout 不是 JSON' };
  }
}

/** 截断过长的 transcript 片段（避免单文件无限增长）。 */
function capped(text) {
  const value = typeof text === 'string' ? text : '';
  return value.length > MAX_TRANSCRIPT_STDOUT
    ? `${value.slice(0, MAX_TRANSCRIPT_STDOUT)}\n…（transcript 已截断）`
    : value;
}

/** 一次运行（materialize → CLI → 覆盖验收器 → verify → 清理）。 */
async function runOne(mod, options, spec, index, root, transcripts) {
  const sandbox = mod.LongTaskSandbox.materialize({
    spec,
    fixturesRoot: join(options.tasksDir, 'fixtures'),
    rootDir: root,
  });
  const store = mkdtempSync(join(root, `store-${spec.id}-`));
  const args = cliArgsOf(spec, sandbox.dir, store, options.model);
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: sandbox.dir,
    env: envOf(options, spec),
    encoding: 'utf8',
    timeout: spec.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const wallMs = Date.now() - started;
  const errorCode =
    typeof result.error === 'object' && result.error !== null ? result.error.code : undefined;
  const timedOut = result.signal === 'SIGTERM' || errorCode === 'ETIMEDOUT';
  const parsed = timedOut ? { ok: false, error: 'timeout' } : parsedJson(result.stdout ?? '');
  const tokens = mod.LongTaskSessionUsage.read(store, parsed.sessionId);
  // 验收器从 verifiers/ 覆盖写入：模型改过 verify.mjs 也不算数。
  cpSync(join(options.tasksDir, 'verifiers', `${spec.id}.mjs`), join(sandbox.dir, 'verify.mjs'));
  const verify = await mod.LongTaskVerify.run(spec, sandbox.dir);
  const missingFiles = spec.expectedFiles.filter((file) => !existsSync(join(sandbox.dir, file)));
  const ok =
    !timedOut &&
    result.status === 0 &&
    parsed.ok === true &&
    verify.ok &&
    missingFiles.length === 0;
  const transcript = transcripts.write(
    spec.id,
    index,
    [
      `# task=${spec.id} run=${String(index + 1)} k=${String(options.k)}`,
      `# exit=${String(result.status)} timedOut=${String(timedOut)} wallMs=${String(wallMs)} tokens=${String(tokens)}`,
      `# verifyExit=${String(verify.exitCode)} verifyTimedOut=${String(verify.timedOut)} ok=${String(ok)}`,
      `# command: node ${args.slice(1).join(' ')}`,
      '',
      '## stdout',
      capped(result.stdout ?? ''),
      '',
      '## stderr',
      capped(result.stderr ?? ''),
      '',
      '## verify output',
      capped(verify.output),
      '',
      '## missing files',
      missingFiles.length === 0 ? '(none)' : missingFiles.join('\n'),
      '',
    ].join('\n'),
  );
  rmSync(sandbox.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(store, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return {
    ok,
    tokens,
    wallMs,
    steps: typeof parsed.steps === 'number' ? parsed.steps : undefined,
    exitCode: result.status,
    timedOut,
    verifyOk: verify.ok,
    verifyExitCode: verify.exitCode,
    missingFiles,
    transcript,
    error: timedOut ? 'timeout' : parsed.error,
  };
}

/** 人类可读摘要（每任务一行 + 总计）。 */
function humanSummary(report) {
  const lines = [];
  for (const task of report.tasks) {
    const summary = task.summary;
    lines.push(
      `${task.id}: pass@k=${String(summary.passAtK)} pass^k=${String(summary.passAllK)} ` +
        `tok/solved=${summary.tokensPerSolved === null ? 'n/a' : String(summary.tokensPerSolved)} ` +
        `runs=${String(summary.successes)}/${String(summary.runs)}`,
    );
  }
  const aggregate = report.aggregate;
  lines.push(
    `总计: tasks=${String(aggregate.tasks)} pass@1=${aggregate.passAt1.toFixed(3)} ` +
      `pass@k=${aggregate.passAtK.toFixed(3)} pass^k=${aggregate.passAllK.toFixed(3)} ` +
      `tok/solved=${aggregate.tokensPerSolved === null ? 'n/a' : String(aggregate.tokensPerSolved)}`,
  );
  lines.push(`transcripts: ${report.transcriptsDir}`);
  if (report.failureModes !== undefined) {
    const modes = report.failureModes;
    lines.push(
      `失败模式: timedOut=${String(modes.timedOut)} verifyFailed=${String(modes.verifyFailed)} ` +
        `missingFiles=${String(modes.missingFiles)} nonzeroExit=${String(modes.nonzeroExit)}`,
    );
  }
  return lines.join('\n');
}

/** 写报告：`--out` 落盘（并打印人类摘要），否则 JSON 打到 stdout + 摘要。 */
function emit(report, options) {
  if (options.out !== undefined) {
    const path = resolve(options.out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`report: ${path}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  console.log(humanSummary(report));
}

/** 真实跑分（已有 key 才调用）。 */
async function runSuite(mod, options, specs, root) {
  const runId = new Date().toISOString().replace(/[:.]/gu, '-');
  const transcripts = new mod.LongTaskTranscripts(transcriptsDirOf(options, runId));
  const report = {
    schemaVersion: 1,
    k: options.k,
    model: options.model ?? null,
    longHorizon: options.longHorizon,
    tasksDir: options.tasksDir,
    transcriptsDir: transcripts.dir,
    tasks: [],
    aggregate: undefined,
  };
  for (const spec of specs) {
    const runs = [];
    for (let index = 0; index < options.k; index += 1) {
      runs.push(await runOne(mod, options, spec, index, root, transcripts));
    }
    report.tasks.push({ id: spec.id, summary: mod.LongTaskMetrics.summarizeTask(runs), runs });
  }
  report.aggregate = mod.LongTaskMetrics.aggregate(
    report.tasks.map((task) => ({ id: task.id, runs: task.runs })),
  );
  report.failureModes = mod.LongTaskFailureBreakdownCounter.summarize(
    report.tasks.map((task) => ({ runs: task.runs })),
  );
  emit(report, options);
}

/** 自检（不需要 key）：参考解必须通过每个任务的验证器。 */
async function runSelfCheck(mod, options, specs, root) {
  const report = await mod.LongTaskSelfCheck.run({
    specs,
    tasksDir: options.tasksDir,
    rootDir: root,
  });
  if (options.out !== undefined) {
    const path = resolve(options.out);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`report: ${path}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  for (const item of report.items) {
    console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.id}: ${item.detail}`);
  }
  console.log(`self-check: ${String(report.passed)} passed / ${String(report.failed)} failed`);
  if (!report.ok) process.exitCode = 1;
}

/** 主流程。 */
async function main() {
  const mod = await loadModules();
  const options = mod.LongTaskRunPlan.parseArgs(process.argv.slice(2), {
    tasksDir: DEFAULT_TASKS_DIR,
  });
  const specs = mod.LongTaskCatalog.filter(
    mod.LongTaskCatalog.load(options.tasksDir),
    options.only,
  );
  if (options.dryRun) {
    console.log(JSON.stringify(mod.LongTaskRunPlan.dryRunReport(options, specs), null, 2));
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'omni-long-'));
  try {
    if (options.selfCheck) {
      await runSelfCheck(mod, options, specs, root);
      return;
    }
    const skip = mod.LongTaskRunPlan.skipReason();
    if (skip !== undefined) {
      console.log(JSON.stringify({ skipped: true, reason: skip }, null, 2));
      return;
    }
    await runSuite(mod, options, specs, root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
