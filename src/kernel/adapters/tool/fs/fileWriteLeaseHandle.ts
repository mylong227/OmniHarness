/**
 * 写租约契约与实现（从 `WorkspaceFileCoordinator` 拆出；协调器已达到「上帝类」阈值，
 * 租约只封装「持锁期间可安全做的文件操作」）。
 */
import { readFile } from 'node:fs/promises';
import { AtomicFileWriter } from '../../../util/concurrency/atomicFileWriter.ts';
import type { AsyncFileLock } from '../../../util/concurrency/asyncFileLock.ts';
import { FileErrorCode } from '../../../util/fileErrorCode.ts';

/** 写租约（写锁持有期间可用）。 */
export interface FileWriteLease {
  /** 绝对路径。 */
  readonly absolutePath: string;
  /**
   * 读取当前内容。
   * @returns 内容；文件不存在时 undefined。
   */
  read(): Promise<string | undefined>;
  /**
   * 原子写入（不自动备份）。
   * @param content 完整内容。
   * @returns 写入完成。
   */
  write(content: string): Promise<void>;
  /**
   * 把当前内容写到 `<file>.bak`（不存在则跳过）。
   * @returns 备份完成。
   */
  backup(): Promise<void>;
  /**
   * 删除目标文件（不存在视为成功）。
   * @returns 删除完成。
   */
  remove(): Promise<void>;
  /**
   * 写盘前核对跨进程锁仍属于自己。
   * @returns 无返回值。
   * @throws LockCompromisedError 锁已被接管时抛出。
   */
  guard(): void;
}

/** 写租约实现。 */
export class FileWriteLeaseHandle implements FileWriteLease {
  /** 绝对路径。 */
  public readonly absolutePath: string;
  /** 已持有的跨进程锁。 */
  private readonly lock: AsyncFileLock;

  /**
   * @param absolutePath 绝对路径。
   * @param lock 已持有的跨进程锁。
   */
  public constructor(absolutePath: string, lock: AsyncFileLock) {
    this.absolutePath = absolutePath;
    this.lock = lock;
  }

  /**
   * 读取当前内容。
   * @returns 内容；文件不存在时 undefined。
   */
  public async read(): Promise<string | undefined> {
    try {
      return await readFile(this.absolutePath, 'utf8');
    } catch (error) {
      if (FileErrorCode.of(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  /**
   * 原子写入（不自动备份）。
   * @param content 完整内容。
   * @returns 写入完成。
   */
  public async write(content: string): Promise<void> {
    this.guard();
    await AtomicFileWriter.write(this.absolutePath, content, { preserveMode: true });
  }

  /**
   * 把当前内容写到 `<file>.bak`（不存在则跳过）。
   * @returns 备份完成。
   */
  public async backup(): Promise<void> {
    const current = await this.read();
    if (current === undefined) return;
    this.guard();
    await AtomicFileWriter.write(`${this.absolutePath}.bak`, current, { preserveMode: false });
  }

  /**
   * 删除目标文件（不存在视为成功）。
   * @returns 删除完成。
   */
  public async remove(): Promise<void> {
    this.guard();
    await AtomicFileWriter.remove(this.absolutePath);
  }

  /**
   * 写盘前核对跨进程锁仍属于自己。
   * @returns 无返回值。
   * @throws LockCompromisedError 锁已被接管时抛出。
   */
  public guard(): void {
    this.lock.guard();
  }
}
