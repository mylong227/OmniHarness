#!/usr/bin/env node
/**
 * 桌面冷启动阶段报告（D1 度量工具，2026-10-25）。
 *
 * 读**真实用户日志**（无需启动 Electron）：
 *   `%APPDATA%/OmniHarness/logs/main-YYYY-MM-DD.log`
 * 解析 `startup.phase phase=<name> elapsedMs=<n>` 与 `spawn harness` / `harness ready on`，
 * 打印相对 boot 的阶段耗时与相邻差值。
 *
 * 用法：
 * ```powershell
 * npm --prefix desktop run startup:report
 * npm --prefix desktop run startup:report -- --budget-ms=5000
 * ```
 *
 * 退出码：0 = 有 `harness.ready` 且（给预算时）未超；1 = 超预算；2 = 找不到日志/标记。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 解析 `--key=value`。 */
const argOf = (name) => {
  const token = process.argv.find((item) => item.startsWith(`--${name}=`));
  return token === undefined ? undefined : token.slice(name.length + 3);
};

const logDir =
  argOf('dir') ??
  (process.env['APPDATA'] !== undefined
    ? join(process.env['APPDATA'], 'OmniHarness', 'logs')
    : join(homedir(), '.config', 'OmniHarness', 'logs'));

let names;
try {
  names = readdirSync(logDir).filter((name) => /^main-.*\.log$/u.test(name));
} catch {
  names = [];
}
if (names.length === 0) {
  process.stderr.write(`✗ 找不到主进程日志：${logDir}（先启动一次桌面应用）\n`);
  process.exit(2);
}
names.sort();
const file = join(logDir, names[names.length - 1]);
const text = readFileSync(file, 'utf8');
const PHASE = /startup\.phase phase=([a-z.]+) elapsedMs=(\d+)/gu;
const phases = [];
for (const match of text.matchAll(PHASE)) phases.push({ phase: match[1], ms: Number(match[2]) });
if (phases.length === 0) {
  process.stderr.write(`✗ ${file} 里没有 startup.phase 标记（旧版本？）\n`);
  process.exit(2);
}
const boot = phases[0].ms;
process.stdout.write(`log: ${file}\n`);
let previous = 0;
for (const { phase, ms } of phases) {
  process.stdout.write(
    `  ${phase.padEnd(18)} ${String(ms).padStart(7)} ms  (+${String(ms - previous).padStart(6)} ms)\n`,
  );
  previous = ms;
}
const ready = phases.find((item) => item.phase === 'harness.ready');
if (ready === undefined) {
  process.stderr.write('✗ 本次启动未到 harness.ready（启动失败或日志被截断）\n');
  process.exit(2);
}
const budget = Number(argOf('budget-ms') ?? Number.NaN);
if (Number.isFinite(budget)) {
  const ok = ready.ms - boot <= budget;
  process.stdout.write(
    `${ok ? '✓' : '✗'} harness.ready ${String(ready.ms - boot)} ms ｜ 预算 ≤ ${String(budget)} ms\n`,
  );
  process.exit(ok ? 0 : 1);
}
