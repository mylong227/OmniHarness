import type { SpillHandle, SpillPort } from '../../ports/spill.js';
import { id } from '../../util/id.js';

/**
 * @beta
 * 内存外溢端口（测试/临时场景）：内容随进程生命周期存在，不落盘。
 */
export class MemorySpill implements SpillPort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'memory'，不落盘）。 */
  public readonly name = 'memory';

  private readonly store = new Map<string, string>();

  /** 保存内容并返回句柄。 */
  public async spill(content: string, _sessionId: string): Promise<SpillHandle> {
    const handle = { id: id('spill'), bytes: Buffer.byteLength(content, 'utf8') };
    this.store.set(handle.id, content);
    return handle;
  }

  /** 读回内容。 */
  public async read(spillId: string): Promise<string | undefined> {
    return this.store.get(spillId);
  }
}
