/**
 * exec.ts —— OmniHarness CLI **薄入口**（冷启动优化后的进程入口）。
 *
 * 动机（2026-09-04 实测，见 benchmark/efficiency_benchmark.mjs）：
 *   | 阶段                        | P50    |
 *   |-----------------------------|--------|
 *   | Node 进程基线                | ~152ms |
 *   | 加载整条 CLI 继承链(cliAgentCmds) | +685ms |
 *   即冷启动的**唯一瓶颈**是静态加载整条命令继承链，而 `--version`、`--help`
 *   这类路径根本不需要它。
 *
 * 设计：本文件只静态依赖轻量的 `args.js` / `version.js`（实测 <20ms），
 * 把无需执行引擎的快速路径前置；仅当真正要执行命令时才动态 import `./execImpl.js`。
 *
 * 入口约束：package.json 的 bin 指向 dist/src/cli/exec.js，故 main()/isEntry 必须留在本文件。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_VERSION } from '../version.js';
import { printUsage } from './argParser.js';

/** 求助标志集合。 */
const HELP_FLAGS: ReadonlySet<string> = new Set(['--help', '-h']);

/** 进程入口。 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // 快速路径 ①：版本查询 —— 零重模块加载
  if (argv.includes('--version') || argv.includes('-V')) {
    process.stdout.write(`omniharness ${API_VERSION}\n`);
    process.exitCode = 0;
    return;
  }

  // 快速路径 ②：显式求助 —— 零重模块加载（退出码与原先 parseArgs 失败路径一致，为 2）
  if (argv.some((flag) => HELP_FLAGS.has(flag))) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  // 慢路径：真正要执行命令，才加载整条继承链
  const { ExecCli } = await import('./execCli.js');
  const exitCode = await new ExecCli().run(argv);
  process.exitCode = exitCode;
}

// 仅作为入口直接执行时启动（避免 import 时副作用）。
const isEntry =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  void main();
}
