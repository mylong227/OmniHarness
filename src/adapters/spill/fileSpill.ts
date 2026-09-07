import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SpillHandle, SpillPort } from '../../ports/spill.js';
import { id } from '../../util/id.js';

/** 合法外溢 ID（防目录穿越：id 会被拼进文件路径）。 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * @beta
 * 文件外溢端口：完整内容落盘，跨进程/重启可恢复。
 */
export class FileSpill implements SpillPort {
  readonly name = 'file';

  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  /** 保存内容并返回句柄。 */
  async spill(content: string, _sessionId: string): Promise<SpillHandle> {
    await mkdir(this.root, { recursive: true });
    const handle = { id: id('spill'), bytes: Buffer.byteLength(content, 'utf8') };
    await writeFile(this.pathOf(handle.id), content, 'utf8');
    return handle;
  }

  /** 读回内容（id 非法或文件缺失返回 undefined）。 */
  async read(spillId: string): Promise<string | undefined> {
    if (!SAFE_ID.test(spillId)) {
      return undefined;
    }
    try {
      return await readFile(this.pathOf(spillId), 'utf8');
    } catch {
      return undefined;
    }
  }

  /** 外溢文件路径。 */
  private pathOf(spillId: string): string {
    return join(this.root, `${spillId}.txt`);
  }
}
