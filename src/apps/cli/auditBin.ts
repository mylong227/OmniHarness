/**
 * audit **独立入口**（瘦 bin，2026-11-03 P1「一条命令」T1.1）。
 *
 * 为什么不直接 bin 到 exec.js：execCli 装配整个 CLI 世界（serve / mcp / plugin / eval / …），
 * 静态依赖树是全量 CLI。本入口只引 {@link AuditCommand}（audit 应用零运行时依赖，
 * 见 docs/audit/README.md §1 的盘点），经 `scripts/buildAuditBin.mjs` 单文件 bundle 后
 * 必须 ≤ 300 KB（体积判据内置在打包器里，超限即失败）。
 *
 * **依赖约束（判据盯着）**：本文件不得 import execCli / execLocal / cliDataCmds /
 * cliBuildConfig / argParser / cliFlagTable 等装配层模块——一旦引入，bundle 会被
 * 整个 CLI 世界拖大，`tests/unit/auditBinDeps.test.ts` 与体积判据都会红。
 *
 * 旗标与退出码语义与 `omniharness audit` 完全一致（同一 {@link AuditCommand} 实现，
 * 契约见 docs/audit/EXIT_CODES.md）；`--help` 顶部多打一行 Node 版本门槛（P1 风险项：
 * engines.node ≥ 22.14 挡人，要让它在第一屏可见）。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_VERSION } from '../../version.ts';
import { AuditCommand } from './auditCommand.ts';

/**
 * Node 版本下限（与 `package.json` 的 `engines.node` 必须逐字一致）。
 * 不从 package.json 运行时读取：bundle 是单文件，内联常量才离线可用；
 * 两处漂移由 `tests/unit/auditBinDeps.test.ts` 机械对账。
 */
export const AUDIT_NODE_REQUIRE = '>=22.14.0';

/**
 * audit 独立入口。
 */
export class AuditBin {
  /**
   * 进程入口：`--version` 快速路径 → 帮助头部（Node 门槛）→ 交给 AuditCommand。
   * @returns Promise<void>
   */
  public static async main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.includes('--version') || argv.includes('-V')) {
      process.stdout.write(`omniharness audit ${API_VERSION}\n`);
      process.exitCode = 0;
      return;
    }
    if (argv.length === 0 || argv.some((flag) => flag === '--help' || flag === '-h')) {
      // 头部先打，AuditCommand 的 USAGE 随后打印——版本门槛因此出现在 --help 顶部。
      process.stdout.write(
        `omniharness audit（独立出证入口）· 需要 Node ${AUDIT_NODE_REQUIRE}（当前 ${process.version}）\n\n`,
      );
    }
    const code = await new AuditCommand().run(argv);
    process.exitCode = code;
  }
}

// 仅作为入口直接执行时启动（避免 import 时副作用；与 exec.ts 同一口径）。
const isEntry =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  AuditBin.main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`omniharness audit: 启动失败：${message}\n`);
    process.exitCode = 1;
  });
}
