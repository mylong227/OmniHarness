/**
 * 会话附件外置存储（2026-10-20）。
 *
 * ## 为什么需要
 *
 * 工具结果里的图片附件原先以 base64 内联在 `tool_result.files[].data`，随 JSONL 一起落盘：
 * 单会话 7 张截图 = 6.28 MiB，占本机全部会话存档的 80%，列表扫描每次都可能整读它。
 * 本适配器在**落盘时**把超过阈值的附件写到
 * `.omniharness/sessions/attachments/<sha256>.<ext>`，事件里只留
 * `{name, mediaType, path}`；读回时由 `ContextAssembler` 按路径**水合**成 base64 再送模型。
 *
 * ## 边界
 *
 * - 只处理 `data` 超过 {@link SPILL_THRESHOLD_CHARS} 的附件；小附件保持内联（少一次 IO，
 *   也让测试夹具/文本附件的行为不变）。
 * - 内容寻址（sha256）：同一张图重复出现只落一份；`wx` 写入 + `EEXIST` 忽略保证幂等。
 * - `WeakMap<SessionEvent, SessionEvent>` 缓存：`save()` 每次拿全量事件，已处理过的事件
 *   不会重复 hash/写盘（长会话里这一步会被调用几十次）。
 * - 不改内存中的事件（recorder 仍持有 data，当前回合照常可用）；只改**落盘副本**。
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { FileAttachment } from '../../ports/model/fileAttachment.ts';
import type { SessionEvent } from '../../ports/runtime/event.ts';
import type { AttachmentSpillPort } from '../../ports/context/attachmentSpillPort.ts';

/** 触发外置的最小 base64 字符数：256K 字符 ≈ 192 KiB 原始字节。 */
export const SPILL_THRESHOLD_CHARS = 256 * 1024;

/**
 * 记录**内存事件**前的更激进阈值（64K 字符 ≈ 48 KiB 原始字节）。
 *
 * 落盘副本可以晚一点外置（小附件少一次 IO），但内存里的 base64 会一直留到进程结束；
 * 截图/图片型会话在记录前就换成 path，模型仍按 path 水合，UI 只显示 chip 名称。
 */
export const MEMORY_SPILL_THRESHOLD_CHARS = 64 * 1024;

/** mediaType → 扩展名（未知类型回落到文件名扩展名 / `.bin`）。 */
const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
};

/** 事件 payload 里本适配器关心的切片。 */
interface FilesPayload {
  readonly files?: readonly FileAttachment[];
  readonly [key: string]: unknown;
}

export class SessionAttachmentSpiller implements AttachmentSpillPort {
  /** 已处理事件 → 落盘副本（避免每次 save 重新 hash 大字符串）。 */
  private readonly cache = new WeakMap<SessionEvent, SessionEvent>();

  /**
   * @param sessionsDir 会话存档根目录（附件写到其下 `attachments/`）。
   */
  public constructor(private readonly sessionsDir: string) {}

  /**
   * 在**记录事件前**外置大附件（内存预算）。
   *
   * 与 {@link sanitize} 的区别：本方法直接面向 `ToolResult.files`，阈值更低（64K 字符），
   * 返回的附件只含 `path`、不含 `data`；模型投影时由 `ContextAssembler` 按路径水合。
   * 小附件/已有 path 的附件原样返回，行为与未接线一致。
   * @param _sessionId 会话 ID（内容寻址不需要；保留参数）。
   * @param files 原始附件。
   * @returns 外置后的附件。
   */
  public async spillFiles(
    _sessionId: string,
    files: readonly FileAttachment[],
  ): Promise<readonly FileAttachment[]> {
    if (
      !files.some(
        (file) => typeof file.data === 'string' && file.data.length > MEMORY_SPILL_THRESHOLD_CHARS,
      )
    ) {
      return files;
    }
    const dir = join(this.sessionsDir, 'attachments');
    await mkdir(dir, { recursive: true });
    return Promise.all(files.map((file) => this.spillOne(dir, file, MEMORY_SPILL_THRESHOLD_CHARS)));
  }

  /**
   * 把事件里的超大附件外置，返回**落盘用**的事件副本。
   *
   * 附件按内容寻址存放在**全局** `attachments/` 下（不带 sessionId）：fork 出来的会话
   * 仍引用同一份字节，删除原会话也不会把 fork 的图片一起删掉；同一张图重复出现只落一份。
   *
   * @param _sessionId 会话标识（保留参数以对齐调用点；内容寻址不需要它）。
   * @param event 原始事件（内存中的对象不被修改）。
   * @returns 落盘副本；无需外置时原样返回同一对象。
   */
  public async sanitize(_sessionId: string, event: SessionEvent): Promise<SessionEvent> {
    const cached = this.cache.get(event);
    if (cached !== undefined) {
      return cached;
    }
    const payload = event.payload as FilesPayload | undefined;
    const files = payload?.files;
    if (
      files === undefined ||
      !files.some(
        (file) => typeof file.data === 'string' && file.data.length > SPILL_THRESHOLD_CHARS,
      )
    ) {
      return event;
    }
    const dir = join(this.sessionsDir, 'attachments');
    await mkdir(dir, { recursive: true });
    const sanitizedFiles = await Promise.all(files.map((file) => this.spillOne(dir, file)));
    const sanitized: SessionEvent = {
      ...event,
      payload: { ...(payload as FilesPayload), files: sanitizedFiles },
    };
    this.cache.set(event, sanitized);
    return sanitized;
  }

  /**
   * 外置单个附件（小附件原样返回）。
   *
   * @param dir 附件根目录（`sessions/attachments`）。
   * @param file 原始附件。
   * @param minChars 触发外置的最小 base64 字符数（缺省 {@link SPILL_THRESHOLD_CHARS}）。
   * @returns 落盘用附件（大附件含**相对 sessions 根**的 `path`、不含 `data`）。
   */
  private async spillOne(
    dir: string,
    file: FileAttachment,
    minChars: number = SPILL_THRESHOLD_CHARS,
  ): Promise<FileAttachment> {
    const data = file.data;
    if (typeof data !== 'string' || data.length <= minChars) {
      return file;
    }
    const bytes = Buffer.from(data, 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const name = `${digest}${SessionAttachmentSpiller.extensionOf(file)}`;
    try {
      await writeFile(join(dir, name), bytes, { flag: 'wx' });
    } catch (error) {
      // 内容寻址：同一份字节已写过是正常情况；其它错误（权限/磁盘满）上抛，由落盘层 warn。
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    const { data: _data, ...rest } = file;
    // 存**相对 sessions 根**的 POSIX 路径：搬移/备份整个 sessions 目录后仍可解析，
    // 不再依赖某台机器的绝对路径（读取方用 `StoragePort.location` 拼接）。
    return { ...rest, path: `attachments/${name}` };
  }

  /**
   * 选定附件扩展名。
   * @param file 附件。
   * @returns 以点开头的扩展名（未知类型回落 `.bin`）。
   */
  private static extensionOf(file: FileAttachment): string {
    const byMedia = MEDIA_EXTENSIONS[file.mediaType.toLowerCase()];
    if (byMedia !== undefined) {
      return byMedia;
    }
    const byName = extname(file.name).toLowerCase();
    return /^\.[a-z0-9]{1,8}$/u.test(byName) ? byName : '.bin';
  }
}
