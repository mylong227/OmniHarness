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
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'file'）。 */
  public readonly name = 'file';

  /** 外溢文件根目录（构造时解析为绝对路径；每个外溢 id 一个 .txt 文件）。 */
  private readonly root: string;

  /**
   * 构造文件外溢适配器：解析根目录（懒创建，首次 spill 时 mkdir）。
   * @param directory 外溢存储根目录。
   */
  public constructor(directory: string) {
    this.root = resolve(directory);
  }

  /** 保存内容并返回句柄。
   * @param content 待外溢的完整文本内容（UTF-8 落盘）。
   * @param _sessionId 会话标识（当前实现未参与路径，保留参数以符合端口签名）。
   * @returns 外溢句柄（全局唯一 id 与内容字节数）；目录不存在时自动创建。
   */
  public async spill(content: string, _sessionId: string): Promise<SpillHandle> {
    await mkdir(this.root, { recursive: true });
    const handle = { id: id('spill'), bytes: Buffer.byteLength(content, 'utf8') };
    await writeFile(this.pathOf(handle.id), content, 'utf8');
    return handle;
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
