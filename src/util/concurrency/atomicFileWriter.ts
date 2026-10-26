/**
 * 原子文本写入：**同目录临时文件 + rename**，让读者永远看到「旧完整内容」或「新完整内容」，
 * 而不是写了一半的撕裂文件。
 *
 * 为什么不能只用 `writeFile(target)`：Node 的 `writeFile` 先截断再写。另一个会话/进程在
 * 截断与写完之间读文件，会拿到**空串或半截内容**（模型据此改代码会把文件改坏）；进程在此时
 * 崩溃则文件永久停在一半。`rename` 在同一文件系统内是原子的，这是解决该问题的标准做法。
 *
 * Windows 上杀毒/索引器短暂占用会让 `rename` 返回 `EPERM/EBUSY`。这里按**指数退避 + 抖动**
 * 有界重试（最多 20 次），仍失败则抛错——不静默退化为非原子写。
 *
 * `durable: true` 额外对临时文件 `fsync`（并在 POSIX 上 sync 父目录）：适合账本/审计等
 * **掉电后必须仍在**的数据；普通工作区文件默认不付这笔代价。
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** 写入选项。 */
export interface AtomicWriteOptions {
  /** 是否沿用目标文件已有权限位（POSIX；Windows 忽略）。 */
  readonly preserveMode?: boolean | undefined;
  /** 是否 `fsync`（临时文件 + POSIX 父目录）；默认 false（工作区文件可重建）。 */
  readonly durable?: boolean | undefined;
}

/** 原子文件写入器（无状态）。 */
export class AtomicFileWriter {
  /** `rename` 最多尝试次数（含首次）。 */
  private static readonly MAX_RENAME_ATTEMPTS = 20;

  /**
   * 原子写入文本（父目录不存在时自动创建）。
   * @param target 目标绝对路径。
   * @param content 完整内容。
   * @param options 权限保留等选项。
   * @returns 写入完成（rename 已落地）。
   */
  public static async write(
    target: string,
    content: string,
    options: AtomicWriteOptions = {},
  ): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    const mode = options.preserveMode === false ? undefined : await AtomicFileWriter.modeOf(target);
    const temp = AtomicFileWriter.tempPathOf(target);
    let renamed = false;
    try {
      if (options.durable === true) {
        const handle = await open(temp, 'w');
        try {
          await handle.writeFile(content, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else {
        await writeFile(temp, content, 'utf8');
      }
      if (mode !== undefined && process.platform !== 'win32') {
        await chmod(temp, mode).catch(() => undefined);
      }
      await AtomicFileWriter.renameWithRetry(temp, target);
      renamed = true;
      if (options.durable === true) await AtomicFileWriter.syncDirectory(dirname(target));
    } finally {
      if (!renamed) {
        await unlink(temp).catch(() => undefined);
      }
    }
  }

  /**
   * 删除文件（不存在视为成功）。
   * @param target 目标绝对路径。
   * @returns 无返回值。
   */
  public static async remove(target: string): Promise<void> {
    await unlink(target).catch((error: unknown) => {
      if (AtomicFileWriter.codeOf(error) !== 'ENOENT') throw error;
    });
  }

  /**
   * 读目标文件权限位（仅 POSIX 有意义）。
   * @param target 目标路径。
   * @returns `mode & 0o777`；文件不存在或平台为 Windows 时 undefined。
   */
  private static async modeOf(target: string): Promise<number | undefined> {
    if (process.platform === 'win32') return undefined;
    try {
      const info = await stat(target);
      return info.isFile() ? info.mode & 0o777 : undefined;
    } catch (error) {
      if (AtomicFileWriter.codeOf(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  /**
   * 生成同目录临时文件名（隐藏前缀 + pid + 随机后缀，避免并发撞名）。
   * @param target 目标路径。
   * @returns 临时文件绝对路径。
   */
  private static tempPathOf(target: string): string {
    const suffix = randomBytes(6).toString('hex');
    return join(dirname(target), `.${basename(target)}.omni-${String(process.pid)}-${suffix}.tmp`);
  }

  /**
   * POSIX 上 sync 父目录，保证 rename 目录项也落盘（Windows 目录句柄 fsync 不可用/无意义）。
   * @param dir 目录。
   * @returns 无返回值。
   */
  private static async syncDirectory(dir: string): Promise<void> {
    if (process.platform === 'win32') return;
    try {
      const handle = await open(dir, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // 目录 fsync 失败不改变"文件已 rename"的事实；不把可选耐久性变成写失败。
    }
  }

  /**
   * 带指数退避的 rename（仅对 Windows 上可恢复的占用错误重试）。
   * @param from 临时文件。
   * @param to 目标文件。
   * @returns 无返回值。
   * @throws 超过重试次数或不可恢复错误。
   */
  private static async renameWithRetry(from: string, to: string): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < AtomicFileWriter.MAX_RENAME_ATTEMPTS; attempt += 1) {
      try {
        await rename(from, to);
        return;
      } catch (error) {
        last = error;
        if (!AtomicFileWriter.retryable(error)) throw error;
        // Windows 上读者用普通 `readFile` 打开目标时，rename 会短暂 EPERM（目标句柄未共享 delete）。
        // 退避上限 100ms：持续读压力下也能在 ~1.5s 内等到一个关闭窗口；仍失败则如实报错。
        const delay = Math.min(100, 5 * 2 ** attempt) + Math.floor(Math.random() * 10);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error(
      `原子替换失败（${String(AtomicFileWriter.MAX_RENAME_ATTEMPTS)} 次重试后目标仍被占用或不可写）: ${to}` +
        `；原因：${last instanceof Error ? last.message : String(last)}`,
      { cause: last },
    );
  }

  /**
   * 判断错误是否值得重试（Windows 杀毒/索引器占用）。
   * @param error 任意错误。
   * @returns 可重试时为 true。
   */
  private static retryable(error: unknown): boolean {
    const code = AtomicFileWriter.codeOf(error);
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EEXIST';
  }

  /**
   * 取错误码。
   * @param error 任意错误。
   * @returns `code` 字段；没有时 undefined。
   */
  private static codeOf(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null
      ? (error as { code?: string }).code
      : undefined;
  }
}
