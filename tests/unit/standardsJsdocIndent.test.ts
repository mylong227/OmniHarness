/**
 * 「JSDoc 续行缩进」标准规则的测试包裹。
 *
 * 规则本体在零依赖脚本 `scripts/auditStandards.mjs`（`--delta` 增量门禁会阻断**新增**的脱块注释，
 * pre-commit 第 4 关与 CI 都会跑），但跑 `npm test` 的人也应立刻看到它。故此处以子进程执行全量审计，
 * 断言两条：
 *   ① 度量确实被打印（证明规则已接线，不是只写在注释里）；
 *   ② 真实仓库当前违约数为 **0**（2026-09-24 已对 31 文件 / 94 行做一次性机器修复，此后不得回归）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（dist/tests/unit → 上溯三级）。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * 跑一次全量编码标准审计。
 * @returns 退出码与标准输出/错误文本。
 */
const runAudit = (): { status: number; out: string } => {
  const r = spawnSync(process.execPath, ['scripts/auditStandards.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
};

test('JSDoc 缩进规则：度量已接线，且真实仓库违约数为 0', () => {
  const { status, out } = runAudit();
  assert.strictEqual(status, 0, `标准审计应通过，实际输出尾部：${out.slice(-400)}`);
  const m = out.match(/JSDoc 续行缩进违约（注释脱块）:\s*(\d+)/);
  assert.ok(m !== null, '审计输出里应包含 JSDoc 缩进度量行（规则已接线）');
  assert.strictEqual(Number(m[1]), 0, '真实仓库不得存在「注释脱离所属 JSDoc 块」的续行');
});
