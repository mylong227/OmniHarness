import { appendFile } from 'node:fs/promises';
import type { SessionEvent } from '../ports/event.js';

/** JSONL 写出器：事件流结构化输出（stdout 或文件）。 */
export class JsonlWriter {
  public constructor(private readonly target?: string) {}

  /**
   * 写出一条事件。
   * @param event 会话事件（JSONL 单行落盘或 stdout）
   * @returns 无返回值。
   */
  public async write(event: SessionEvent): Promise<void> {
    const line = JSON.stringify(event);
    if (this.target === undefined) {
      process.stdout.write(`${line}\n`);
      return;
    }
    await appendFile(this.target, `${line}\n`, 'utf8');
  }

  /**
   * 批量写出。
   * @param events 会话事件序列（逐条复用 write）
   * @returns 无返回值。
   */
  public async writeAll(events: readonly SessionEvent[]): Promise<void> {
    for (const event of events) {
      await this.write(event);
    }
  }
}
