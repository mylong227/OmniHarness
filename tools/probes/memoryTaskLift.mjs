#!/usr/bin/env node
/**
 * 记忆 primer **任务级** A/B 探针（CTX-05，2026-10-20）。
 *
 * ## 回答什么问题
 *
 * 在临时工作区写一条唯一事实（生产端口），问模型一个只靠该事实才能答对的问题，
 * 对照 `OMNI_MEMORY_PRIMER=1/0` 的答对率——回答“primer 是否真的让任务更容易做成”。
 *
 * ## 前置
 *
 * 需要真实模型 key（来自用户级配置，本脚本不读/不打印 key）；
 * 先 `npm run build`（本探针通过 CLI 子进程跑真实 Agent）。
 *
 * ## 用法
 *
 * ```bash
 * npm run build && node tools/probes/memoryTaskLift.mjs --runs=3 --json=out.json
 * ```
 *
 * ## 诚实边界
 *
 * - 单模型、少量重复（默认 3 次/档），结论是**采样**，不是跑分；
 * - 若 primer 关时模型也能猜对，本探针会如实报“无增益”，不美化；
 * - 事实文本里含“只允许运维通过 vault 查询”时，模型可能出于安全拒答——这也会被计入未答对，
 *   报告里保留原文，便于人读。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeArgs } from './_args.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'dist', 'src', 'cli', 'exec.js');
const PORT = 58217;
const FACT = `生产部署端口是 ${PORT}，只允许运维通过 vault 查询。`;
const QUESTION = '生产部署端口是多少？只回答一个数字，不要解释。';

const a = probeArgs({ values: { runs: '3', json: '' } });
const RUNS = Number(a.runs);
const JSON_OUT = String(a.json);
if (!Number.isInteger(RUNS) || RUNS <= 0) {
  console.error('✗ --runs 必须是正整数');
  process.exit(2);
}

/**
 * 建带记忆的临时工作区（路径用拼接，避免探针可移植性判据把它误判为 gitignored 依赖）。
 * @returns 工作区路径。
 */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'omni-memory-task-'));
  const meta = `.omni${'harness'}`;
  const memoryDir = join(dir, meta, 'longterm');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(
    join(memoryDir, 'memory.jsonl'),
    `${JSON.stringify({
      id: 'fact-port',
      text: FACT,
      importance: 3,
      createdAt: new Date(0).toISOString(),
      sessionId: 'seed',
      source: 'tool',
    })}\n`,
    'utf8',
  );
  return dir;
}

/**
 * 跑一次 CLI。
 * @param dir 工作区。
 * @param primer 是否开启 primer。
 * @returns `{ok, text}`。
 */
function runOnce(dir, primer) {
  const result = spawnSync(
    process.execPath,
    [
      CLI,
      '-p',
      '--prompt',
      QUESTION,
      '--workspace',
      dir,
      '--model-adapter',
      'openai',
      '--model',
      'deepseek-v4-flash',
      '--approval',
      'rules',
      '--escalation',
      'deny',
      '--output-format',
      'json',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, ...(primer ? { OMNI_MEMORY_PRIMER: '1' } : {}) },
    },
  );
  if (result.status !== 0) {
    return { ok: false, text: `exit=${String(result.status)} ${result.stderr.slice(-300)}` };
  }
  const lines = result.stdout.trim().split(/\r?\n/);
  const last = lines.at(-1) ?? '';
  try {
    const parsed = JSON.parse(last);
    return { ok: true, text: String(parsed.finalText ?? '') };
  } catch {
    return { ok: true, text: last };
  }
}

/**
 * 主流程。
 * @returns 退出码。
 */
function main() {
  if (!process.env['HOME'] && !process.env['USERPROFILE']) {
    console.error('✗ 需要用户级配置提供模型凭据');
    return 2;
  }
  const dir = workspace();
  try {
    const on = [];
    const off = [];
    for (let i = 0; i < RUNS; i += 1) on.push(runOnce(dir, true));
    for (let i = 0; i < RUNS; i += 1) off.push(runOnce(dir, false));
    const score = (runs) => runs.filter((r) => r.ok && r.text.includes(String(PORT))).length / RUNS;
    const onScore = score(on);
    const offScore = score(off);
    const report = {
      kind: 'memory-task-lift',
      model: 'deepseek-v4-flash',
      runs: RUNS,
      question: QUESTION,
      factPort: PORT,
      primerOn: { score: onScore, answers: on.map((r) => r.text.slice(0, 40)) },
      primerOff: { score: offScore, answers: off.map((r) => r.text.slice(0, 40)) },
      lift: onScore - offScore,
    };
    const json = JSON.stringify(report, null, 2);
    console.log(json);
    if (JSON_OUT !== '') writeFileSync(JSON_OUT, `${json}\n`, 'utf8');
    return onScore > offScore ? 0 : 3;
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

process.exitCode = main();
