import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEvent } from '../../ports/event.js';
import type { StoragePort } from '../../ports/storage.js';

/** JSONL 文件存储适配器：每个会话一个 .jsonl 文件（可观测、可回放）。 */
export class JsonlStorage implements StoragePort {
  public readonly name = 'jsonl';
  public readonly location: string;

  public constructor(private readonly directory: string) {
    this.location = directory;
  }

  /** 保存会话事件。 */
  public async save(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    const file = this.fileOf(sessionId);
    await mkdir(this.directory, { recursive: true });
    const lines = events.map((event) => JSON.stringify(event)).join('\n');
    await writeFile(file, `${lines}\n`, 'utf8');
  }

  /** 加载会话事件（文件不存在返回空）。 */
  public async load(sessionId: string): Promise<readonly SessionEvent[]> {
    try {
      const content = await readFile(this.fileOf(sessionId), 'utf8');
      return this.parseLines(content);
    } catch {
      return [];
    }
  }

  /** 会话文件路径。 */
  private fileOf(sessionId: string): string {
    return join(this.directory, `${sessionId}.jsonl`);
  }

  /** 解析 JSONL 文本为事件列表。 */
  private parseLines(content: string): readonly SessionEvent[] {
    return content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as SessionEvent);
  }
}
