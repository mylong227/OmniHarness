/**
 * 维护巡检编排器（2026-10-26，「彻底解决磁盘爆炸」的自动面收口）。
 *
 * ## 为什么需要编排器（各自为政的失败模式）
 *
 * 仓里其实早有 `TmpSweep`（2026-10-22 写的临时目录清扫器）——但它**没有任何生产调用方**，
 * 是一段永远不跑的死代码；`ServeInstance.sweep` 只在"新 serve 起同一端口"时被调，而临时端口
 * 几乎不会被重启；会话存档则连保留策略都没有。结果就是 2026-10-26 实测的 Temp 19 GB
 * （`omni-cdp-*` ×1000 = 9.2 GB + `omni-crash-*` ×114 = 1.1 GB，两个前缀还都不在清扫名单里）。
 * 编排器把四件事拧成一个入口，serve 启动 / 周期定时 / `gc` 子命令三方共用，各扫各的账：
 *
 * 1. **临时目录清扫**（`TmpSweep`，只认本仓前缀 + 超龄）：扫**两个根**——归属根下的 `tmp/`
 *    （新归属，`OmniHome.tmpRoot()`）与 OS Temp（历史孤儿兜底）；
 * 2. **陈旧 serve 实例记录**（`ServeInstance.sweepAll`，判活失败即删）；
 * 3. **会话保留策略**（`SessionGc`：keepNewest / 年龄 / 总量封顶 + 孤儿附件）；
 * 4. **会话目录半截临时文件**（`SessionArchiveLayout.sweepTempFiles`，跨分区搬运中断残留）。
 *
 * ## 全部 best-effort（维护永远不能变成新的故障源）
 *
 * 每个子步骤独立 try/catch 进报告，任何一步失败都不抛——serve 启动路径调它，
 * 维护失败绝不能挡住服务起来。
 *
 * ## 旋钮（环境变量，`OMNI_MAINTENANCE=off` 一键全关）
 *
 * - `OMNI_MAINTENANCE=off|0|false`：整体停用；
 * - `OMNI_GC_KEEP` / `OMNI_GC_MAX_AGE_DAYS` / `OMNI_GC_MAX_BYTES`：会话保留策略三参数；
 * - `OMNI_MAINTENANCE_INTERVAL_HOURS`：serve 周期巡检间隔（缺省 6 小时）。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OmniHome } from './omniHome.ts';
import { SessionGc, type SessionGcOptions, type SessionGcReport } from './sessionGc.ts';
import { TmpSweep, type TmpSweepReport } from './tmpSweep.ts';
import { SessionArchiveLayout } from './sessionArchiveLayout.ts';
import { ServeInstance, type ServeInstanceRecord } from '../cli/serveInstance.ts';
import { SessionStorageLocation } from './sessionStorageLocation.ts';

/** 巡检选项（全部可注入；缺省值见各类常量）。 */
export interface MaintenanceOptions {
  /** 扫描的临时根列表（缺省 `[OmniHome.tmpRoot(), os.tmpdir()]`）。 */
  readonly tmpRoots?: readonly string[] | undefined;
  /** 会话主目录（缺省 `SessionStorageLocation.defaultDir()`）。 */
  readonly sessionsDir?: string | undefined;
  /** 归属根显式覆盖（测试注入；同时决定 tmp 根与 pid 记录目录）。 */
  readonly home?: string | undefined;
  /** 临时条目年龄阈值（毫秒；缺省 24h）。 */
  readonly olderThanMs?: number | undefined;
  /** 会话 keepNewest（缺省 `SessionGc.DEFAULT_KEEP_NEWEST`）。 */
  readonly keepNewest?: number | undefined;
  /** 会话年龄阈值（缺省 `SessionGc.DEFAULT_MAX_AGE_MS`）。 */
  readonly sessionMaxAgeMs?: number | undefined;
  /** 会话总字节上限（缺省 `SessionGc.DEFAULT_MAX_BYTES`）。 */
  readonly sessionMaxBytes?: number | undefined;
  /** 只报告不删除。 */
  readonly dryRun?: boolean | undefined;
  /** 受控时钟（测试）。 */
  readonly now?: number | undefined;
  /** 环境变量源（测试注入；缺省 `process.env`）。 */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** 判活注入（测试；缺省真探活）。 */
  readonly aliveFn?: ((pid: number) => boolean) | undefined;
}

/** 巡检报告（各子步骤的账目汇总）。 */
export interface MaintenanceReport {
  /** 是否实际执行（`OMNI_MAINTENANCE=off` 时为 false，其余字段为空账）。 */
  readonly enabled: boolean;
  /** 本轮是否 dry-run（各子步骤只报告不删除）。 */
  readonly dryRun: boolean;
  /** 停用原因（enabled 时为 undefined）。 */
  readonly reason?: string | undefined;
  /** 每个临时根一份清扫报告。 */
  readonly tmp: readonly TmpSweepReport[];
  /** 被清扫的陈旧 serve 实例记录。 */
  readonly pidSwept: readonly ServeInstanceRecord[];
  /** 会话 GC 报告（从未运行——例如目录不存在——时为 null）。 */
  readonly sessions: SessionGcReport | null;
  /** 会话目录半截临时文件清理数。 */
  readonly sessionTempFiles: number;
}

/** 维护巡检编排器（无状态；serve 启动 / 周期 / CLI `gc` 共用同一实现）。 */
export class MaintenanceRunner {
  /** 周期巡检缺省间隔（6 小时）。 */
  public static readonly DEFAULT_INTERVAL_HOURS = 6;

  /**
   * 从环境变量解析会话 GC 三参数（未设时回落调用方给定值）。
   * @param env 环境变量源。
   * @param base 缺省值。
   * @returns 解析后的三参数（非法值忽略、回落缺省——旋钮写错不能让维护停摆）。
   */
  public static gcParamsFromEnv(
    env: NodeJS.ProcessEnv,
    base: { keepNewest: number; maxAgeMs: number; maxBytes: number },
  ): { keepNewest: number; maxAgeMs: number; maxBytes: number } {
    const out = { ...base };
    const keep = env['OMNI_GC_KEEP'];
    if (keep !== undefined && Number.isFinite(Number(keep)) && Number(keep) >= 0) {
      out.keepNewest = Math.floor(Number(keep));
    }
    const ageDays = env['OMNI_GC_MAX_AGE_DAYS'];
    if (ageDays !== undefined && Number.isFinite(Number(ageDays)) && Number(ageDays) > 0) {
      out.maxAgeMs = Number(ageDays) * 24 * 60 * 60 * 1000;
    }
    const maxBytes = env['OMNI_GC_MAX_BYTES'];
    if (maxBytes !== undefined && Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0) {
      out.maxBytes = Number(maxBytes);
    }
    return out;
  }

  /**
   * 执行一轮巡检（全 best-effort，绝不抛）。
   * @param options 巡检选项。
   * @returns 报告。
   */
  public static run(options: MaintenanceOptions = {}): MaintenanceReport {
    const env = options.env ?? process.env;
    const disabled = /^(off|0|false)$/i.test((env['OMNI_MAINTENANCE'] ?? '').trim());
    const empty: MaintenanceReport = {
      enabled: false,
      dryRun: options.dryRun === true,
      reason: 'OMNI_MAINTENANCE=off',
      tmp: [],
      pidSwept: [],
      sessions: null,
      sessionTempFiles: 0,
    };
    if (disabled) return empty;

    const now = options.now ?? Date.now();
    const tmpRoots = options.tmpRoots ?? [OmniHome.tmpRoot(options.home, env), tmpdir()];
    // 显式注入 home（判据）走注入路径；生产路径走 SessionStorageLocation（它还认 OMNI_SESSIONS_DIR）。
    const sessionsDir =
      options.sessionsDir ??
      (options.home !== undefined
        ? join(OmniHome.dir(options.home, env), 'sessions')
        : SessionStorageLocation.defaultDir());
    const gcParams = MaintenanceRunner.gcParamsFromEnv(env, {
      keepNewest: options.keepNewest ?? SessionGc.DEFAULT_KEEP_NEWEST,
      maxAgeMs: options.sessionMaxAgeMs ?? SessionGc.DEFAULT_MAX_AGE_MS,
      maxBytes: options.sessionMaxBytes ?? SessionGc.DEFAULT_MAX_BYTES,
    });

    // 每步独立兜错：维护失败绝不外抛（serve 启动路径在调）。
    const tmp = MaintenanceRunner.sweepTmp(tmpRoots, options, now);

    let pidSwept: ServeInstanceRecord[] = [];
    try {
      pidSwept = [
        ...ServeInstance.sweepAll(options.home, options.aliveFn, options.dryRun === true),
      ];
    } catch {
      /* 判活环境异常时跳过本轮 */
    }

    let sessions: SessionGcReport | null = null;
    const gcOptions: SessionGcOptions = {
      sessionsDir,
      keepNewest: gcParams.keepNewest,
      maxAgeMs: gcParams.maxAgeMs,
      maxBytes: gcParams.maxBytes,
      dryRun: options.dryRun,
      now,
    };
    try {
      sessions = SessionGc.run(gcOptions);
    } catch {
      /* 会话目录不可读等：跳过本轮 */
    }

    let sessionTempFiles = 0;
    try {
      sessionTempFiles =
        options.dryRun === true ? 0 : SessionArchiveLayout.sweepTempFiles(sessionsDir);
    } catch {
      /* 半截临时文件下轮再清 */
    }

    return {
      enabled: true,
      dryRun: options.dryRun === true,
      tmp,
      pidSwept,
      sessions,
      sessionTempFiles,
    };
  }

  /**
   * 逐个临时根清扫（单根失败不挡其余根）。
   * @param roots 临时根。
   * @param options 巡检选项。
   * @param now 当前时刻。
   * @returns 各根报告。
   */
  private static sweepTmp(
    roots: readonly string[],
    options: MaintenanceOptions,
    now: number,
  ): TmpSweepReport[] {
    const reports: TmpSweepReport[] = [];
    for (const root of roots) {
      try {
        reports.push(
          TmpSweep.run({
            tmpDir: root,
            olderThanMs: options.olderThanMs,
            dryRun: options.dryRun,
            now,
          }),
        );
      } catch {
        /* 单根失败不挡其余根 */
      }
    }
    return reports;
  }

  /**
   * 把报告压成一行人话（进 serve 启动日志 / `gc` 命令输出）。
   * @param report 巡检报告。
   * @returns 一行摘要。
   */
  public static summarize(report: MaintenanceReport): string {
    if (!report.enabled) return `维护巡检已停用（${report.reason ?? ''}）`;
    const tmpRemoved = report.tmp.reduce((sum, entry) => sum + entry.removed, 0);
    const parts = [
      `临时条目 ${String(tmpRemoved)}`,
      `陈旧实例记录 ${String(report.pidSwept.length)}`,
    ];
    if (report.sessions !== null) {
      // 删除清单是文件级（.jsonl + sidecar），会话组按「去后缀的基路径」去重计数。
      const groupCount = new Set(
        report.sessions.deletedGroups.map((file) => {
          const norm = file.replace(/\\/g, '/');
          return norm.endsWith('.jsonl.summary.json')
            ? norm.slice(0, -'.jsonl.summary.json'.length)
            : norm.slice(0, -'.jsonl'.length);
        }),
      ).size;
      parts.push(
        `会话组 ${String(groupCount)}`,
        `孤儿附件 ${String(report.sessions.deletedAttachments.length)}`,
      );
    }
    return `维护巡检：${parts.join('，')}，释放 ${MaintenanceRunner.formatBytes(
      report.sessions?.freedBytes ?? 0,
    )}（不含临时条目）`;
  }

  /**
   * serve 启动入口：跑一轮巡检 + 挂周期定时器。
   *
   * 「真清了东西才打印一行」（避免每次启动刷屏）；全 best-effort——巡检失败绝不挡 serve 起来。
   * @param stderr 进程 stderr（判据注入用；缺省 `process.stderr`）。
   * @returns 无返回值。
   */
  public static startup(stderr: { write: (chunk: string) => void } = process.stderr): void {
    const maintenance = MaintenanceRunner.run();
    if (!maintenance.enabled) return;
    const removed =
      maintenance.tmp.reduce((sum, entry) => sum + entry.removed, 0) +
      maintenance.pidSwept.length +
      (maintenance.sessions?.deletedGroups.length ?? 0) +
      (maintenance.sessions?.deletedAttachments.length ?? 0);
    if (removed > 0) {
      stderr.write(`[omniharness] ${MaintenanceRunner.summarize(maintenance)}\n`);
    }
    MaintenanceRunner.schedule(() => MaintenanceRunner.run());
  }

  /**
   * 周期巡检定时器（serve 常驻期间用；`unref` 不挡进程退出）。
   * @param run 每轮执行体（通常 `() => MaintenanceRunner.run()`）。
   * @param env 环境变量源（`OMNI_MAINTENANCE_INTERVAL_HOURS` 覆盖；测试注入）。
   * @returns 定时器句柄（serve 退出如需停止可 clearInterval）。
   */
  public static schedule(
    run: () => MaintenanceReport,
    env: NodeJS.ProcessEnv = process.env,
  ): NodeJS.Timeout {
    const hours = Number(env['OMNI_MAINTENANCE_INTERVAL_HOURS']);
    const interval =
      Number.isFinite(hours) && hours > 0 ? hours : MaintenanceRunner.DEFAULT_INTERVAL_HOURS;
    const timer = setInterval(run, interval * 60 * 60 * 1000);
    timer.unref?.();
    return timer;
  }

  /**
   * 字节数的人话格式（KB/MB/GB 自适应，一位小数）。
   * @param bytes 字节数。
   * @returns 形如 `13.4 MB`。
   */
  public static formatBytes(bytes: number): string {
    if (bytes < 1024) return `${String(bytes)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 'B';
    for (const next of units) {
      if (value < 1024) break;
      value /= 1024;
      unit = next;
    }
    return `${value.toFixed(1)} ${unit}`;
  }
}
