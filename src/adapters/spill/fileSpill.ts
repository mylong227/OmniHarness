import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SpillHandle, SpillPort } from '../../ports/memory/spill.ts';
import { Id } from '../../util/id.ts';
import { log } from '../../util/logger.ts';

/** 合法外溢 ID（防目录穿越：id 会被拼进文件路径）。 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** 文件外溢的默认保留上限（个）：超出即按 mtime 删最旧的（审计 §1.7「产物无回收」）。 */
export const DEFAULT_SPILL_MAX_FILES = 512;

/** 文件外溢的默认总字节上限：64 MiB（单文件数上限无法约束总磁盘）。 */
export const DEFAULT_SPILL_MAX_BYTES = 64 * 1024 * 1024;

/** 文件外溢保留选项。 */
export interface FileSpillOptions {
  /**
   * 保留的外溢文件上限（个，默认 {@link DEFAULT_SPILL_MAX_FILES}）。
   *
   * 为什么必须有上限：外溢发生的时机是「工具输出很大」，而大型构建/测试历史里这种事**反复发生**，
   * 此前的实现只写不删 ⇒ `.omniharness/spill` 无界增长（单文件可达 MB 级）。
   * 回收策略取「按 mtime 删最旧」：`spill_read` 的现实用法是**同一回合内回读**，最旧的先被淘汰；
   * 被淘汰的 id 再读会得到 `undefined`（与「不存在」同语义，fail-closed，且会告警）。
   * `0` 或负数表示**不按条数回收**（仍受 `maxBytes` 约束）。
   */
  readonly maxFiles?: number | undefined;
  /**
   * 总字节上限（默认 {@link DEFAULT_SPILL_MAX_BYTES}）。
   *
   * 只限条数不够：512 个 10 MB 的输出仍是 5 GB。按 mtime 淘汰最旧，**至少保留最新一份**
   * （否则刚写的外溢立刻不可读，等于功能失效）。
   */
  readonly maxBytes?: number | undefined;
}

/**
 * @beta
 * 文件外溢端口：完整内容落盘，跨进程/重启可恢复。
 */
export class FileSpill implements SpillPort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'file'）。 */
  public readonly name = 'file';

  /** 外溢文件根目录（构造时解析为绝对路径；每个外溢 id 一个 .txt 文件）。 */
  private readonly root: string;

  /** 保留上限（0 = 不按条数回收）。 */
  private readonly maxFiles: number;

  /** 总字节上限（0 = 不按字节回收）。 */
  private readonly maxBytes: number;

  /**
   * 构造文件外溢适配器：解析根目录（懒创建，首次 spill 时 mkdir）。
   * @param directory 外溢存储根目录。
   * @param options 保留策略（可选；缺省取 {@link DEFAULT_SPILL_MAX_FILES}/{@link DEFAULT_SPILL_MAX_BYTES}）。
   */
  public constructor(directory: string, options: FileSpillOptions = {}) {
    this.root = resolve(directory);
    this.maxFiles = options.maxFiles ?? DEFAULT_SPILL_MAX_FILES;
    this.maxBytes = options.maxBytes ?? DEFAULT_SPILL_MAX_BYTES;
  }

  /** 保存内容并返回句柄（写入后按上限回收最旧文件）。
   * @param content 待外溢的完整文本内容（UTF-8 落盘）。
   * @param _sessionId 会话标识（当前实现未参与路径，保留参数以符合端口签名）。
   * @returns 外溢句柄（全局唯一 id 与内容字节数）；目录不存在时自动创建。
   */
  public async spill(content: string, _sessionId: string): Promise<SpillHandle> {
    await mkdir(this.root, { recursive: true });
    const handle = { id: Id.id('spill'), bytes: Buffer.byteLength(content, 'utf8') };
    await writeFile(this.pathOf(handle.id), content, 'utf8');
    await this.collect();
    return handle;
  }

  /**
   * 回收：文件数/总字节超过上限时，按 mtime 从最旧开始删除（best-effort，失败只告警不抛错）。
   *
   * 为什么是 mtime 而不是文件名：id 是随机串，不含时间序；mtime 才代表「最后被写入的时刻」。
   * **至少保留最新一份**：即便单份就超字节预算，也不能把刚写的外溢删掉（那会让 `spill_read`
   * 永远读不回本次输出）；超预算的长期处置是下一次写入时淘汰它。
   * @returns 删除的文件数。
   */
  public async collect(): Promise<number> {
    if (this.maxFiles <= 0 && this.maxBytes <= 0) {
      return 0;
    }
    let names: string[];
    try {
      names = (await readdir(this.root)).filter((name) => name.endsWith('.txt'));
    } catch (error) {
      log.warn('spill.collect.readdirFailed', { root: this.root, error: String(error) });
      return 0;
    }
    const stamped: { readonly file: string; readonly mtimeMs: number; readonly size: number }[] =
      [];
    let totalBytes = 0;
    for (const name of names) {
      const file = join(this.root, name);
      try {
        const info = await stat(file);
        stamped.push({ file, mtimeMs: info.mtimeMs, size: info.size });
        totalBytes += info.size;
      } catch {
        // 并发删除/权限问题：跳过该条（下次 collect 再说），不影响其余回收。
      }
    }
    stamped.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let removed = 0;
    // 删不掉的条目仍占「保留名额」：把它们计入条数预算，否则 maxFiles=2 时会出现
    // 「目录 old.txt + 两个新文件 = 3 个条目」仍然停手（旧判据只数可删数组）。
    let unremovable = 0;
    while (stamped.length > 1) {
      const overCount = this.maxFiles > 0 && stamped.length + unremovable > this.maxFiles;
      const overBytes = this.maxBytes > 0 && totalBytes > this.maxBytes;
      if (!overCount && !overBytes) break;
      const oldest = stamped.shift();
      if (oldest === undefined) break;
      try {
        await rm(oldest.file, { force: true });
        totalBytes -= oldest.size;
        removed += 1;
      } catch (error) {
        log.warn('spill.collect.removeFailed', { file: oldest.file, error: String(error) });
        // 该条删不掉（并发/权限/目录同名）：跳过它继续删下一条，不中断整体回收。
        unremovable += 1;
      }
    }
    if (removed > 0) {
      log.debug('spill.collect.removed', {
        removed,
        limit: this.maxFiles,
        bytes: totalBytes,
        maxBytes: this.maxBytes,
      });
    }
    return removed;
  }

  /** 读回内容（id 非法或文件缺失返回 undefined）。
   * @param spillId 外溢句柄 id（必须匹配 SAFE_ID，防目录穿越）。
   * @returns 落盘的原始文本；id 非法或读取失败时为 undefined（不抛错）。
   */
  public async read(spillId: string): Promise<string | undefined> {
    if (!SAFE_ID.test(spillId)) {
      return undefined;
    }
    try {
      return await readFile(this.pathOf(spillId), 'utf8');
    } catch {
      return undefined;
    }
  }

  /** 外溢文件路径。
   * @param spillId 外溢 id（调用前须通过 SAFE_ID 校验）。
   * @returns 根目录下的 `<spillId>.txt` 完整路径。
   */
  private pathOf(spillId: string): string {
    return join(this.root, `${spillId}.txt`);
  }
}
