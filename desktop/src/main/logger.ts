/** 桌面日志：主进程 / Harness stdout+stderr 分文件，脱敏 + 环形缓冲。 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

/** 日志种类。 */
export type LogKind = 'main' | 'harness';

/** 简单文件日志器。 */
export class DesktopLogger {
  private readonly dir: string;
  private readonly mainStream: WriteStream;
  private readonly harnessStream: WriteStream;
  private readonly ring: string[] = [];

  /**
   * @param dir 日志目录。
   */
  public constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    this.mainStream = createWriteStream(join(dir, `main-${day}.log`), { flags: 'a' });
    this.harnessStream = createWriteStream(join(dir, `harness-${day}.log`), { flags: 'a' });
  }

  /**
   * 写一行日志（脱敏后落盘 + 进环形缓冲）。
   * @param kind 种类。
   * @param text 内容。
   * @returns 无返回值。
   */
  public write(kind: LogKind, text: string): void {
    const clean = DesktopLogger.redact(text.replace(/\u001b\[[0-9;]*m/gu, ''));
    const line = `${new Date().toISOString()} [${kind}] ${clean}\n`;
    if (kind === 'main') this.mainStream.write(line);
    else this.harnessStream.write(line);
    this.ring.push(line.trimEnd());
    if (this.ring.length > 200) this.ring.shift();
  }

  /**
   * 最近日志（用于启动失败面板/诊断）。
   * @returns 行数组。
   */
  public recent(): readonly string[] {
    return this.ring;
  }

  /**
   * 日志目录。
   * @returns 绝对路径。
   */
  public directory(): string {
    return this.dir;
  }

  /**
   * 关闭文件流。
   * @returns 无返回值。
   */
  public close(): void {
    this.mainStream.end();
    this.harnessStream.end();
  }

  /**
   * 脱敏：Token / Bearer / API Key。
   * @param text 原文。
   * @returns 脱敏文本。
   */
  public static redact(text: string): string {
    return text
      .replace(/([?&]token=)[^&\s]+/gu, '$1***')
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gu, 'Bearer ***')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, 'sk-***');
  }
}
