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
import { ArgParser } from './argParser.js';

/**
 * Exec 相关纯函数工具（C7 收口：原顶层内部函数迁入）。
 */
export class Exec {
  /**
   * 进程入口。
  
   * @returns Promise<void>
   */
  public static async main(): Promise<void> {
    const argv = process.argv.slice(2);

    // 快速路径 ①：版本查询 —— 零重模块加载
    if (argv.includes('--version') || argv.includes('-V')) {
      process.stdout.write(`omniharness ${API_VERSION}\n`);
      process.exitCode = 0;
      return;
    }

    // 快速路径 ②：显式求助 —— 零重模块加载（退出码与原先 parseArgs 失败路径一致，为 2）
    if (argv.some((flag) => HELP_FLAGS.has(flag))) {
      ArgParser.printUsage();
      process.exitCode = 2;
      return;
    }

    // 慢路径：真正要执行命令，才加载整条继承链
    // 进程级护栏（§22.7 第 5 条收口）在**此处**安装而不是文件顶层：顶层静态 import 会让
    // `--version` / `--help` 这两条冷启动快速路径也付出代价（本文件的存在理由就是省这笔）。
    // 为什么必须兜全局：`void promise` 在本仓很常见（后台任务、事件桥、插件注册），
    // 漏掉 `.catch` 的第 N 个照样能把进程带走；逐点补 catch 治标不治本。
    const [{ CrashGuard }, { log }, { ExecCli }] = await Promise.all([
      import('./crashGuard.js'),
      import('../util/logger.js'),
      import('./execCli.js'),
    ]);
    CrashGuard.install({
      proc: process,
      report: (r) => {
        const fields = {
          kind: r.kind,
          count: r.count,
          ...(r.stack !== undefined ? { stack: r.stack } : {}),
        };
        if (r.kind === 'unhandledRejection') {
          log.warn(`未处理的 Promise 拒绝：${r.message}`, fields);
          return;
        }
        log.error(`${r.kind === 'signal' ? '终止信号' : '未捕获异常'}：${r.message}`, fields);
      },
      // 收尾：让 stdout/stderr 写干净（护栏最终走 `process.exit`，会截断尚未落盘的写）。
      shutdown: () => {
        process.exitCode = process.exitCode ?? 1;
      },
    });
    process.exitCode = await new ExecCli().run(argv);
  }
}

/** 求助标志集合。 */
const HELP_FLAGS: ReadonlySet<string> = new Set(['--help', '-h']);

// 仅作为入口直接执行时启动（避免 import 时副作用）。
const isEntry =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  // `main()` 是浮动 Promise：子命令分发若在 try/catch 之外抛出（例如 `runServe` 启动失败），
  // 就是一条 unhandledRejection —— Node 22 默认终止进程并打裸栈，用户看不到可行动的提示。
  // 这里统一收口为「人话 + 非零退出码」（与 `CrashGuard` 互补：护栏兜全局，这条兜 main 自身，
  // 且护栏此时可能尚未安装——模块加载失败就属于这一类）。
  Exec.main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`omniharness: 启动失败：${message}\n`);
    process.exitCode = 1;
  });
}
