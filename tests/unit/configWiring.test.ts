/**
 * 接线完整性门禁的测试包裹。
 *
 * 门禁本体是无第三方依赖脚本 `scripts/auditConfigWiring.mjs`（pre-commit 第 7 关与 CI 都会跑），
 * 但「跑 `npm test` 的人」也应立刻看到它——故此处以子进程执行并断言退出码。
 *
 * 断言两条：
 *   ① 真实仓库审计必须 0（否则说明存在未接线字段）；
 *   ② `--selftest` 必须 0（护栏自身的故障注入用例全部可触发，证明**不是假绿**）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSyncAsync } from '../helpers/childProcess.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（dist/tests/unit → 上溯三级）。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * 跑一次接线完整性门禁。
 * @param arg 可选命令行参数（如 `--selftest`）。
 * @returns 退出码与标准输出/错误文本。
 */
const runAudit = async (arg?: string): Promise<{ status: number; out: string }> => {
  const r = await spawnSyncAsync(
    process.execPath,
    ['scripts/auditConfigWiring.mjs', ...(arg ? [arg] : [])],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
};

test('门禁自检：每条不变量均可触发（含 I6 内建数据随包发布，护栏不是假绿）', async () => {
  const { status, out } = await runAudit('--selftest');
  assert.strictEqual(status, 0, `selftest 应全通过，实际输出：${out}`);
  assert.match(out, /selftest 全部通过/);
});

test('真实仓库接线完整性全绿', async () => {
  const { status, out } = await runAudit();
  assert.strictEqual(status, 0, `存在未接线字段：${out}`);
});
