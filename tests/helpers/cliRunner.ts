import { spawnSyncAsync } from './childProcess.ts';
import { resolve } from 'node:path';

/**
 * CLI 入口路径：以**子进程**驱动真实 CLI，而非在测试进程内劫持 `process.stdout`。
 *
 * 原因（踩坑记录）：劫持 stdout 会与 `node --test` 的 TAP 报告器抢同一路 stdout，
 * 导致首个用例的结果行被吞、runner 少计一个用例。子进程方式无此冲突，且是更真实的端到端。
 *
 * 2026-10-11 抽出：`cliDataCmds.test.ts` 在**覆盖率插桩 + 全量并发**下撞过 120s 文件超时
 * （单跑仅 54s，插桩后每文件预算被并发争用顶穿）⇒ 拆成 `cliDataCmds` / `cliBoostCmds` 两个文件，
 * 本助手随之抽出共用（两文件各自仍在 120s 预算内）。
 */
export const cliPath = resolve(process.cwd(), 'dist/src/cli/exec.js');

/**
 * 以子进程运行 CLI。
 *
 * @param args CLI 参数（不含 node 与入口路径）。
 * @returns 退出码与 stdout/stderr 文本。
 */
export async function runCli(
  args: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  const r = await spawnSyncAsync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}
