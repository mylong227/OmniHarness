#!/usr/bin/env node
/**
 * 真实模型 A/B：规划守卫关/开 对同一复杂任务的行为差异。
 *
 * 需要真实凭据（`OMNIHARNESS_API_KEY`，或由环境层 `OMNIHARNESS_BASE_URL`/`OMNIHARNESS_MODEL` 指定端点）。
 * 无凭据时输出 `{ skipped: true }` 并以 0 退出——**绝不**用 mock 冒充真实模型 A/B。
 *
 * 用法：
 *   node scripts/agentPlanningAb.mjs
 *   OMNIHARNESS_API_KEY=... OMNIHARNESS_MODEL=deepseek-chat node scripts/agentPlanningAb.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'src', 'cli', 'exec.js');
const TASK =
  '在临时工作区里实现一个小功能并验证：先阅读 package.json，创建一个 hello.txt 写入 hello，' +
  '再读取它确认内容，最后报告结果。需要多步完成。';

if (!existsSync(CLI)) {
  console.error('缺少 dist；先运行 npm run build');
  process.exit(2);
}
if (process.env.OMNIHARNESS_API_KEY === undefined) {
  console.log(JSON.stringify({ skipped: true, reason: 'OMNIHARNESS_API_KEY 未设置' }, null, 2));
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'omni-planning-ab-'));
const results = [];
try {
  for (const guard of ['0', '1']) {
    const storage = mkdtempSync(join(root, `store-${guard}-`));
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [CLI, '-p', TASK, '--output-format', 'json', '--approval', 'auto'],
      {
        cwd: root,
        env: {
          ...process.env,
          OMNI_PLANNING_GUARD: guard,
          OMNIHARNESS_STORAGE_ADAPTER: 'jsonl',
          OMNIHARNESS_STORAGE_DIR: storage,
        },
        encoding: 'utf8',
        timeout: 600_000,
      },
    );
    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      parsed = {
        ok: false,
        error: '输出不是 JSON',
        stdout: result.stdout.slice(0, 500),
        stderr: result.stderr.slice(0, 500),
      };
    }
    const sessionFile =
      parsed.sessionId === undefined ? undefined : join(storage, `${parsed.sessionId}.jsonl`);
    let todoWrites = 0;
    if (sessionFile !== undefined && existsSync(sessionFile)) {
      todoWrites = readFileSync(sessionFile, 'utf8')
        .split('\n')
        .filter((line) => line.includes('"type":"todo"')).length;
    }
    results.push({
      guard: guard === '1' ? 'on' : 'off',
      exitCode: result.status,
      durationMs: Date.now() - started,
      steps: parsed.steps,
      todoWrites,
      ok: parsed.ok === true,
      finalTextLength: typeof parsed.finalText === 'string' ? parsed.finalText.length : 0,
    });
  }
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(JSON.stringify({ task: TASK, results }, null, 2));
