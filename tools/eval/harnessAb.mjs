#!/usr/bin/env node
/**
 * Harness A/B 跑分器（评测契约的可执行入口）。
 *
 * 目标不是「刷榜单」，而是回答一个可证伪的问题：**同一任务、同一模型，只改 harness 配置，
 * 成功率 / pass^k / tokens-per-solved 是否真的变了**。报告同时给出原始 run，便于复核。
 *
 * 用法：
 *   node tools/eval/harnessAb.mjs --a '{"OMNI_TOOL_EXPOSURE":"off"}' --b '{"OMNI_TOOL_EXPOSURE":"plan"}'
 *   node tools/eval/harnessAb.mjs --tasks tasks.json --k 3 --out report.json
 *   node tools/eval/harnessAb.mjs --dry-run
 *
 * 依赖：先 `npm run build`（脚本消费 `dist/src/eval/abMetrics.js` 与 `dist/src/cli/exec.js`）。
 * 无凭据时输出 `{skipped:true}` 并以 0 退出——绝不用 mock 冒充真实 A/B。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'dist', 'src', 'cli', 'exec.js');
const METRICS = join(ROOT, 'dist', 'src', 'eval', 'abMetrics.js');

/** 内置任务：每个都有机械验收（文件存在 + 内容），不是看模型自述。 */
const DEFAULT_TASKS = [
  {
    id: 'write-hello',
    prompt: '在当前工作区创建 hello.txt，内容写 hello，然后读取它确认。完成后简短报告。',
    files: { 'hello.txt': 'hello' },
  },
  {
    id: 'two-files',
    prompt: '在当前工作区创建 a.txt 写 1，创建 b.txt 写 2，然后读取两个文件确认。完成后简短报告。',
    files: { 'a.txt': '1', 'b.txt': '2' },
  },
];

/** 简单 `--key value` / `--key=value` 解析（未知键报错）。 */
function parseArgs(argv) {
  const out = { k: 1, dryRun: false, out: undefined, tasks: undefined, a: undefined, b: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} 需要取值`);
      i += 1;
      return next;
    };
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--k') out.k = Number(value());
    else if (arg === '--out') out.out = value();
    else if (arg === '--tasks') out.tasks = value();
    else if (arg === '--a') out.a = readConfigArg(value());
    else if (arg === '--b') out.b = readConfigArg(value());
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!Number.isInteger(out.k) || out.k < 1) throw new Error('--k 必须是正整数');
  return out;
}

/** 读 JSON 文件（容忍 Windows 写入方带的 UTF-8 BOM）。 */
function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
}

/** 读取配置参数：内联 JSON 或 `@file.json`（PowerShell 引号安全形式）。 */
function readConfigArg(raw) {
  if (raw.startsWith('@')) {
    const parsed = readJsonFile(raw.slice(1));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('--a/--b 必须是 JSON 对象');
    }
    return parsed;
  }
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--a/--b 必须是 JSON 对象');
  }
  return parsed;
}

/** 配置里的敏感键：报告/日志只回显键名，不回显值。 */
const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu;

/** 把配置对象里的敏感值打码（含嵌套对象；报告会落盘/打印，不能带凭据）。 */
function redactConfig(config, depth = 0) {
  if (depth > 8) return '<max-depth>';
  if (Array.isArray(config)) return config.map((value) => redactConfig(value, depth + 1));
  if (typeof config !== 'object' || config === null) return config;
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      SECRET_KEY.test(key) ? '<redacted>' : redactConfig(value, depth + 1),
    ]),
  );
}

/** 读取任务清单（文件或内置）。 */
function loadTasks(path) {
  if (path === undefined) return DEFAULT_TASKS;
  const parsed = readJsonFile(path);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('tasks 文件必须是非空数组');
  for (const task of parsed) {
    if (typeof task?.id !== 'string' || typeof task?.prompt !== 'string') {
      throw new Error('每个 task 必须有字符串 id/prompt');
    }
    if (
      typeof task.files !== 'object' ||
      task.files === null ||
      Array.isArray(task.files) ||
      Object.keys(task.files).length === 0
    ) {
      throw new Error(`task ${task.id} 必须有非空 files（机械验收；没有验收就不算成功）`);
    }
  }
  return parsed;
}

/** 机械验收：每个文件存在且 trim 后等于期望。 */
function verifyFiles(dir, files) {
  for (const [name, expected] of Object.entries(files ?? {})) {
    const file = join(dir, name);
    if (!existsSync(file)) return false;
    if (readFileSync(file, 'utf8').trim() !== String(expected).trim()) return false;
  }
  return true;
}

/** 从会话 JSONL 提取 token 与 manifest。 */
function parseSession(storeDir, sessionId) {
  if (sessionId === undefined) return { tokens: 0, manifest: undefined };
  const file = join(storeDir, `${sessionId}.jsonl`);
  if (!existsSync(file)) return { tokens: 0, manifest: undefined };
  let tokens = 0;
  let manifest;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === 'model' && typeof event.payload?.usage?.totalTokens === 'number') {
      tokens += event.payload.usage.totalTokens;
    }
    if (event?.type === 'session_meta' && event.payload?.manifest !== undefined) {
      manifest = event.payload.manifest;
    }
  }
  return { tokens, manifest };
}

/** 跑一个 task × config × k 次。 */
function runCell(task, config, k, runRoot) {
  const runs = [];
  for (let i = 0; i < k; i += 1) {
    const dir = mkdtempSync(join(runRoot, 'run-'));
    const store = join(dir, 'store');
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        '--print',
        '--prompt',
        task.prompt,
        '--output-format',
        'json',
        '--approval',
        'auto',
        '--workspace',
        dir,
        '--storage-adapter',
        'jsonl',
        '--storage-dir',
        store,
      ],
      {
        cwd: dir,
        env: { ...process.env, ...config },
        encoding: 'utf8',
        timeout: 300_000,
      },
    );
    let parsed;
    try {
      parsed = JSON.parse((result.stdout ?? '').trim());
    } catch {
      parsed = { ok: false, error: 'stdout 不是 JSON' };
    }
    const session = parseSession(store, parsed.sessionId);
    runs.push({
      ok: result.status === 0 && parsed.ok === true && verifyFiles(dir, task.files),
      tokens: session.tokens,
      wallMs: Date.now() - started,
      steps: typeof parsed.steps === 'number' ? parsed.steps : undefined,
      exitCode: result.status,
      manifest: session.manifest,
      error: parsed.error,
    });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  return runs;
}

/** 主流程。 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(CLI) || !existsSync(METRICS)) {
    throw new Error('缺少 dist；先运行 npm run build');
  }
  const { AbMetrics } = await import(pathToFileURL(METRICS).href);
  const tasks = loadTasks(args.tasks);
  const a = args.a ?? {};
  const b = args.b ?? {};
  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          k: args.k,
          tasks: tasks.map((task) => task.id),
          a: redactConfig(a),
          b: redactConfig(b),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (process.env.OMNIHARNESS_API_KEY === undefined && a.OMNIHARNESS_API_KEY === undefined) {
    console.log(
      JSON.stringify(
        { skipped: true, reason: 'OMNIHARNESS_API_KEY 未设置（不用 mock 冒充真实 A/B）' },
        null,
        2,
      ),
    );
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'omni-ab-'));
  const report = { schemaVersion: 1, k: args.k, a: redactConfig(a), b: redactConfig(b), tasks: [] };
  try {
    for (const task of tasks) {
      const runsA = runCell(task, a, args.k, root);
      const runsB = runCell(task, b, args.k, root);
      const summaryA = AbMetrics.summarize(runsA);
      const summaryB = AbMetrics.summarize(runsB);
      report.tasks.push({
        id: task.id,
        a: { summary: summaryA, runs: runsA },
        b: { summary: summaryB, runs: runsB },
        paired: AbMetrics.paired(runsA, runsB),
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const text = JSON.stringify(report, null, 2);
  if (args.out !== undefined) {
    writeFileSync(args.out, text + '\n', 'utf8');
    console.log(`report: ${args.out}`);
  } else {
    console.log(text);
  }
  for (const task of report.tasks) {
    console.log(
      `${task.id}: a pass@k=${task.a.summary.passAtK} pass^k=${task.a.summary.passAllK} ` +
        `tok/solved=${task.a.summary.tokensPerSolved}; b pass@k=${task.b.summary.passAtK} ` +
        `pass^k=${task.b.summary.passAllK} tok/solved=${task.b.summary.tokensPerSolved}; ` +
        `Δsuccess=${task.paired.successDelta.toFixed(2)} tokenRatio=${
          task.paired.tokenRatio === null ? 'n/a' : task.paired.tokenRatio.toFixed(2)
        }`,
    );
  }
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
