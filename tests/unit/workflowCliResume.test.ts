/**
 * CLI `workflow` 子命令的**续跑入口**判据（2026-10-08）。
 *
 * ## 为什么必须真跑一次 CLI
 *
 * `--resume-run` 是本轮新增的**用户面**旗标：它由 `cliAgentCmds.runWorkflow` 用 `flagValue` 直读、
 * 不经 `FLAG_TABLE`，且 `workflow` 子命令还要把参数原样喂给 `ArgParser.parseArgs`（未知旗标 fail-closed）。
 * 也就是说这条路上有**两个**各自独立的失败形态，只有真起一次进程才能同时覆盖：
 * ① 旗标没登记 ⇒ 被未知旗标 fail-closed 打死（本仓 2026-10-06 的真实事故形态）；
 * ② 登记了但没接线 ⇒ 续跑参数被静默忽略、看起来「成功」却重跑了一遍。
 * 故本判据用真 CLI 跑两趟：首跑拿 runId，再 `--resume-run` 复用产出。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** CLI 入口（与 `package.json#bin` 同一份产物）。 */
const CLI_ENTRY = join(process.cwd(), 'dist', 'src', 'cli', 'exec.js');

/** 单步工作流定义文件内容。 */
const SPEC = JSON.stringify({
  name: 'cli-resume-probe',
  steps: [{ id: 's1', prompt: '打个招呼' }],
});

/**
 * 跑一次真 CLI（离线：mock 模型 + auto 审批 + 直通沙箱 + 静默事件）。
 *
 * `stdio` 显式写全为 `['ignore','pipe','pipe']`：本机 Windows 上给子进程建 **stdin 管道**是已知的
 * `EBUSY` 陷阱（`scripts/runGates.mjs` 文件头有实测记录），故 stdin 一律 ignore。
 * @param args 子命令参数
 * @returns 退出码与 stdout/stderr
 */
function runCli(args: readonly string[]): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 180_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * 取出 CLI 打印的 JSON 结果（最后一行非空 stdout）。
 * @param stdout 标准输出
 * @returns 解析后的对象（解析失败即抛）
 */
function resultOf(stdout: string): Record<string, unknown> {
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .pop();
  assert.ok(line !== undefined, `CLI 未打印结果：${stdout}`);
  return JSON.parse(line!) as Record<string, unknown>;
}

/**
 * 公共离线参数（所有用例一致，避免各自漂移）。
 * @param root 工作区根
 * @returns 参数数组
 */
function offlineArgs(root: string): readonly string[] {
  return [
    '--workspace',
    root,
    '--mock',
    '--approval',
    'auto',
    '--sandbox',
    'passthrough',
    '--events',
    'silent',
  ];
}

test('CLI workflow：首跑落盘并回报 runId，随后 --resume-run 复用已完成步骤', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-cli-'));
  try {
    const specPath = join(root, 'spec.json');
    writeFileSync(specPath, SPEC, 'utf8');

    const first = runCli(['workflow', '--file', specPath, ...offlineArgs(root)]);
    assert.strictEqual(first.status, 0, `首跑应成功：${first.stderr.slice(-500)}`);
    const firstJson = resultOf(first.stdout);
    assert.strictEqual(firstJson['ok'], true);
    const runId = firstJson['runId'];
    assert.strictEqual(typeof runId, 'string', `结果必须带 runId：${first.stdout}`);
    assert.deepStrictEqual(firstJson['resumed'], [], '首跑没有可复用的步骤');
    assert.ok(
      existsSync(join(root, '.omniharness', 'graph-runs', `${String(runId)}.jsonl`)),
      '运行存档必须落在 --workspace 指定的工作区（而不是启动目录）',
    );

    // 续跑：不带 --file，规格从存档读回。
    const second = runCli(['workflow', '--resume-run', String(runId), ...offlineArgs(root)]);
    assert.strictEqual(second.status, 0, `续跑应成功：${second.stderr.slice(-500)}`);
    const secondJson = resultOf(second.stdout);
    assert.strictEqual(secondJson['ok'], true);
    assert.strictEqual(secondJson['runId'], runId, '续跑必须沿用同一个 runId');
    assert.deepStrictEqual(secondJson['resumed'], ['s1'], '已完成的步骤应被复用而非重跑');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI workflow：既无 --file 也无 --resume-run ⇒ 用法错误（exit 2，不静默空跑）', () => {
  const result = runCli(['workflow']);
  assert.strictEqual(result.status, 2);
  assert.match(result.stdout, /--resume-run/, '用法提示必须写明续跑入口');
});
