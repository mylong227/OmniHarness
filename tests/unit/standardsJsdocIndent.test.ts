/**
 * 「JSDoc 续行缩进」标准规则的测试包裹。
 *
 * 规则本体在无第三方依赖脚本 `scripts/auditStandards.mjs`（`--delta` 增量门禁会阻断**新增**的脱块注释，
 * pre-commit 第 4 关与 CI 都会跑），但跑 `npm test` 的人也应立刻看到它。故此处以子进程执行全量审计，
 * 断言两条：
 *   ① 度量确实被打印（证明规则已接线，不是只写在注释里）；
 *   ② 真实仓库当前违约数为 **0**（2026-09-24 已对 31 文件 / 94 行做一次性机器修复，此后不得回归）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSyncAsync } from '../helpers/childProcess.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（dist/tests/unit → 上溯三级）。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * 跑一次全量编码标准审计。
 * @returns 退出码与标准输出/错误文本。
 */
const runAudit = async (): Promise<{ status: number; out: string }> => {
  const r = await spawnSyncAsync(process.execPath, ['scripts/auditStandards.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
};

/**
 * 跑规则自证（正例 + 反例成对）。
 * @returns 退出码与输出文本。
 */
const runSelfCheck = async (): Promise<{ status: number; out: string }> => {
  const r = await spawnSyncAsync(
    process.execPath,
    ['scripts/auditStandards.mjs', '--self-check-jsdoc'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
};

test('JSDoc 缩进规则：度量已接线，且真实仓库违约数为 0', async () => {
  const { status, out } = await runAudit();
  assert.strictEqual(status, 0, `标准审计应通过，实际输出尾部：${out.slice(-400)}`);
  const m = out.match(/JSDoc 续行缩进违约（注释脱块）:\s*(\d+)/);
  assert.ok(m !== null, '审计输出里应包含 JSDoc 缩进度量行（规则已接线）');
  assert.strictEqual(Number(m[1]), 0, '真实仓库不得存在「注释脱离所属 JSDoc 块」的续行');
});

test('JSDoc 缩进规则自证：模板字面量不得引发假红，真违约仍须被抓', async () => {
  // 2026-10-06（第六十一轮）：规则原先在**模板字面量**里的注释起始符号上失手——它会被当成注释
  // 起点，把紧随其后的真 JSDoc 一起吞掉。实测后果有两层：① 一份 `:(exclude)${dir}/**` 让 6 行
  // 完全合规的 JSDoc 集体判违约（假红，会逼着人把好代码改坏）；② 扫描错位后**真违约反而漏网**
  // ——修好规则后全仓从「0 违约」变成真实存在 46 处脱块（17 文件），即那句 0 是**假全绿**。
  // 故本判据要求正例（不得假红）与反例（不得漏网）成对通过。
  const { status, out } = await runSelfCheck();
  assert.strictEqual(status, 0, `规则自证应全部通过，实际输出：${out.slice(-400)}`);
  assert.match(out, /jsdocIndent self-check:\s*6\/6/, '自证必须跑满 6 例且全过');
});
