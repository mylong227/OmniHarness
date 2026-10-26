/**
 * gc 子命令（GcCommand）——手动触发一轮维护巡检（2026-10-26，磁盘爆炸收口的手动面）。
 *
 * 与 serve 启动/周期巡检共用 `MaintenanceRunner` 同一实现（单一事实源，不复制编排逻辑）：
 * 临时目录清扫（归属根 tmp/ + OS Temp 兜底）、陈旧 serve 实例记录、会话保留策略
 * （keepNewest/年龄/总量封顶 + 孤儿附件）、会话目录半截临时文件。
 *
 * 用法: omniharness gc [--dry-run]
 * - `--dry-run`：只报告将要清理什么，不动手（审计面）。
 * 输出：一行摘要 + 明细（清了哪些根、哪些实例记录、多少会话组/附件、释放多少字节）。
 * 退出码：0 成功（含 dry-run）；2 用法错误。
 */
import { CliArgReader } from './cliArgReader.ts';
import {
  MaintenanceRunner,
  type MaintenanceOptions,
  type MaintenanceReport,
} from '../util/maintenanceRunner.ts';
import { ServeInstance } from './serveInstance.ts';

/** gc 子命令：手动维护巡检。 */
export class GcCommand {
  /**
   * 执行 gc 子命令。
   * @param args 子命令参数（已去掉 `gc`）。
   * @param runner 巡检执行体（缺省 `MaintenanceRunner.run`；判据注入以隔离真机目录）。
   * @returns 进程退出码（0 成功 / 2 用法错误）。
   */
  public run(
    args: readonly string[],
    runner: (options: MaintenanceOptions) => MaintenanceReport = (options) =>
      MaintenanceRunner.run(options),
  ): number {
    const reader = new CliArgReader(args);
    if (reader.value('--help') !== undefined || args.includes('--help') || args.includes('-h')) {
      process.stdout.write(GcCommand.USAGE);
      return 0;
    }
    if (args.some((arg) => !arg.startsWith('--'))) {
      process.stdout.write(GcCommand.USAGE);
      return 2;
    }
    const dryRun = args.includes('--dry-run');
    const report = runner({ dryRun });
    process.stdout.write(
      `${MaintenanceRunner.summarize(report)}${dryRun ? '（dry-run：未实际删除）' : ''}\n`,
    );
    for (const tmp of report.tmp) {
      if (tmp.removed === 0 && tmp.matched.length === 0) continue;
      const root = tmp.matched[0] ?? '';
      process.stdout.write(
        `  临时清扫：扫描 ${String(tmp.scanned)}，命中 ${String(tmp.matched.length)}，删除 ${String(
          tmp.removed,
        )}（根：${root.slice(0, root.lastIndexOf('\\') + 1) || root}）\n`,
      );
    }
    for (const record of report.pidSwept) {
      const verb = report.dryRun ? '将删除' : '已删除';
      process.stdout.write(`  陈旧实例记录：${verb}（${ServeInstance.describe(record)}）\n`);
    }
    if (report.sessions !== null) {
      for (const file of report.sessions.deletedGroups) {
        process.stdout.write(`  会话组：${file}\n`);
      }
      for (const file of report.sessions.deletedAttachments) {
        process.stdout.write(`  孤儿附件：${file}\n`);
      }
      for (const item of report.sessions.skipped) {
        process.stdout.write(`  跳过：${item}\n`);
      }
    }
    return 0;
  }

  /** 用法说明。 */
  private static readonly USAGE =
    '用法: omniharness gc [--dry-run]\n' +
    '  手动触发一轮维护巡检：临时目录 / 陈旧 serve 实例记录 / 会话保留策略 / 半截临时文件。\n' +
    '  --dry-run  只报告将要清理的内容，不实际删除。\n' +
    '  旋钮：OMNI_MAINTENANCE=off 停用；OMNI_GC_KEEP / OMNI_GC_MAX_AGE_DAYS / OMNI_GC_MAX_BYTES 调会话保留策略。\n';
}
