import type { SpillHandle, SpillPort } from '../../ports/memory/spill.js';
import { Id } from '../../util/id.js';

/**
 * @beta
 * 内存外溢端口（测试/临时场景）：内容随进程生命周期存在，不落盘。
 */
export class MemorySpill implements SpillPort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'memory'，不落盘）。 */
  public readonly name = 'memory';

  /** 外溢内容表：句柄 id → 原文（进程退出即丢失）。 */
  private readonly store = new Map<string, string>();

  /** 保存内容并返回句柄。
   * @param content 待外溢的完整文本内容。
   * @param _sessionId 会话标识（当前实现未参与存储键，保留参数以符合端口签名）。
   * @returns 外溢句柄（全局唯一 id 与内容字节数）。
   */
  public async spill(content: string, _sessionId: string): Promise<SpillHandle> {
    const handle = { id: Id.id('spill'), bytes: Buffer.byteLength(content, 'utf8') };
    this.store.set(handle.id, content);
    return handle;
  }

  /** 读回内容。
   * @param spillId 外溢句柄 id。
   * @returns 存储的原始文本；id 不存在时为 undefined。
   */
  public async read(spillId: string): Promise<string | undefined> {
    return this.store.get(spillId);
  }
}
