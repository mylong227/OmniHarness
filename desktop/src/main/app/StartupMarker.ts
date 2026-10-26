/**
 * 启动阶段标记（D1 度量，2026-10-25）。
 *
 * 固定格式 `startup.phase phase=<name> elapsedMs=<n>` 让 `scripts/startupReport.mjs`
 * 无需启动 Electron 就能读日志、算阶段差。
 */
import type { DesktopLogger } from '../logger.ts';

/** 启动阶段标记器。 */
export class StartupMarker {
  private readonly bootAt = Date.now();

  /**
   * @param logger 主进程日志器。
   */
  public constructor(private readonly logger: DesktopLogger) {}

  /**
   * 记录一个阶段。
   * @param phase 稳定阶段名（不要带动态值）。
   * @returns 无返回值。
   */
  public mark(phase: string): void {
    this.logger.write(
      'main',
      `startup.phase phase=${phase} elapsedMs=${String(Date.now() - this.bootAt)}`,
    );
  }
}
