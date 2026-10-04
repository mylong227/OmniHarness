/**
 * F2 CLI 出口判据（`omniharness evolution history`）：服务必须被**真实路径**消费。
 *
 * ## 判据要钉死什么
 *
 * 1. **逐行可见**：正常台账 ⇒ 每条一行，且带 `✓` 与 `#seq`；
 * 2. **汇总可读**：`--json` 输出可直接被治理台/脚本消费（含 `dir` / `rows` / `summary` / `rollbackTargets`）；
 * 3. **复核失败 ⇒ 非零退出**：`--dir` 指向损坏台账时退出码 1（否则 CI 无法察觉）；
 * 4. **只读**：跑完条目数与链结论不变。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EvolutionCommand } from '../../src/cli/evolutionCommand.js';
import { HashChainPromotionLedger } from '../../src/evolution/hashChainPromotionLedger.js';

/**
 * 采集 stdout/stderr 并跑命令。
 * @param run 被测动作
 * @returns 两条流文本与退出码
 */
async function capture(run: () => Promise<number>): Promise<{
  readonly out: string;
  readonly err: string;
  readonly code: number;
}> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    outChunks.push(String(chunk));
    return true;
  };
  (process.stderr as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    errChunks.push(String(chunk));
    return true;
  };
  try {
    const code = await run();
    return { out: outChunks.join(''), err: errChunks.join(''), code };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = originalOut;
    (process.stderr as unknown as { write: unknown }).write = originalErr;
  }
}

/**
 * 造一个真实台账目录（含快照与晋升）。
 * @returns 目录路径
 */
function ledgerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni-hist-'));
  const ledger = new HashChainPromotionLedger({ dir, now: () => '2026-10-04T00:00:00.000Z' });
  ledger.snapshotBefore([{ name: 'a', description: 'd', instructions: 'i' }]);
  ledger.append({ name: 'b', source: 'twist:a+b' });
  ledger.append({ name: 'c', source: 'pack:demo@pub-1' });
  return dir;
}

test('F2 CLI：history 文本出口逐行可读（含 ✓ 与可回滚快照锚点）', async () => {
  const dir = ledgerDir();
  const command = new EvolutionCommand();
  const { out, code } = await capture(() => command.run(['history', '--dir', dir]));
  assert.strictEqual(code, 0, out);
  assert.match(out, /晋升史：/);
  assert.match(out, /共 3 条，独立复核通过 3 条/);
  assert.match(out, /#1 snapshot/);
  assert.match(out, /#2 promote b ← twist:a\+b/);
  assert.match(out, /✓/);
  assert.match(out, /可回滚快照：#1\(1 技能\)/);
});

test('F2 CLI：--json 出口结构可机读（治理台消费同一份数据）', async () => {
  const dir = ledgerDir();
  const command = new EvolutionCommand();
  const { out, code } = await capture(() => command.run(['history', '--dir', dir, '--json']));
  assert.strictEqual(code, 0);
  const parsed = JSON.parse(out.trim()) as {
    dir: string;
    rows: readonly { seq: number; verified: boolean; name?: string }[];
    summary: { total: number; verified: number };
    rollbackTargets: readonly { seq: number; skillCount: number }[];
  };
  assert.strictEqual(parsed.dir, dir);
  assert.strictEqual(parsed.summary.total, 3);
  assert.strictEqual(parsed.summary.verified, 3);
  assert.deepStrictEqual(
    parsed.rows.map((r) => r.verified),
    [true, true, true],
  );
  assert.deepStrictEqual(parsed.rollbackTargets, [
    { seq: 1, ts: '2026-10-04T00:00:00.000Z', skillCount: 1 },
  ]);
});

test('F2 CLI：复核失败/台账不可用 ⇒ 非零退出（CI 可察觉），且只读不改盘', async () => {
  const dir = ledgerDir();
  const filesBefore = readdirSync(dir).sort();
  const ledgerFile = join(dir, 'ledger.jsonl');
  const before = readFileSync(ledgerFile, 'utf8');
  const command = new EvolutionCommand();

  // 正常跑一次：只读（文件逐字节不变、目录零新增）。
  const ok = await capture(() => command.run(['history', '--dir', dir, '--json']));
  assert.strictEqual(ok.code, 0);
  assert.strictEqual(readFileSync(ledgerFile, 'utf8'), before, '只读命令不得改台账文件');
  assert.deepStrictEqual(readdirSync(dir).sort(), filesBefore, '只读命令不得新增文件');

  // 篡改中间条目正文 ⇒ 复核失败 ⇒ 退出码 1（治理台必须能报红，而不是静默通过）。
  const lines = before.trim().split('\n');
  const tampered = lines.map((line, index) => {
    if (index !== 1) return line;
    const entry = JSON.parse(line) as { promoted?: { name: string; source: string } };
    return JSON.stringify({ ...entry, promoted: { name: 'evil', source: 'x' } });
  });
  writeFileSync(ledgerFile, `${tampered.join('\n')}\n`, 'utf8');
  const tamperedResult = await capture(() => command.run(['history', '--dir', dir, '--json']));
  assert.strictEqual(
    tamperedResult.code,
    1,
    `存在复核失败行必须非零退出（实际输出：${tamperedResult.out.slice(0, 300)}）`,
  );
  const parsed = JSON.parse(tamperedResult.out.trim()) as {
    summary: { verified: number; total: number; firstFailureSeq?: number };
  };
  assert.ok(parsed.summary.verified < parsed.summary.total);
  assert.strictEqual(parsed.summary.firstFailureSeq, 2);

  // 台账目录不存在（新工作区）：**尚未产生 ≠ 错误** —— 与既有 `evolution status` 的口径一致
  // （`0 = 台账完整或尚未产生`），故这里退出码 0，但必须如实说明"0 条"。
  const missing = await capture(() =>
    command.run(['history', '--dir', join(dir, 'nope'), '--json']),
  );
  assert.strictEqual(missing.code, 0, '空台账不是错误（沿 status 口径）');
  const emptyView = JSON.parse(missing.out.trim()) as {
    summary: { total: number; verified: number };
  };
  assert.deepStrictEqual(emptyView.summary, { total: 0, verified: 0 }, '必须如实报 0 条');
});
