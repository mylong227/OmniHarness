import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEvent } from '../../ports/runtime/event.js';
import type { StoragePort } from '../../ports/memory/storage.js';

/** JSONL 文件存储适配器：每个会话一个 .jsonl 文件（可观测、可回放）。 */
export class JsonlStorage implements StoragePort {
  /** 存储适配器名称（标识此 JSONL 文件存储实现）。 */
  public readonly name = 'jsonl';
  /** 存储目录位置（每个会话一个 `.jsonl` 文件）。 */
  public readonly location: string;

  public constructor(
    /** 存储根目录（自动创建；每个会话写一个 `<sessionId>.jsonl`）。 */
    private readonly directory: string,
  ) {
    this.location = directory;
  }

  /** 保存会话事件。
   * @param sessionId 会话标识（决定目标文件名）。
   * @param events 完整事件列表（整文件覆盖写，非追加；末尾补换行）。
   
 * @returns 无返回值。
*/
  public async save(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    const file = this.fileOf(sessionId);
    await mkdir(this.directory, { recursive: true });
    const lines = events.map((event) => JSON.stringify(event)).join('\n');
    await writeFile(file, `${lines}\n`, 'utf8');
  }

  /** 加载会话事件（文件不存在返回空）。
   * @param sessionId 会话标识。
   * @returns 按文件行序解析出的事件列表；文件缺失或不可读时为空数组（不抛错）。
   */
  public async load(sessionId: string): Promise<readonly SessionEvent[]> {
    try {
      const content = await readFile(this.fileOf(sessionId), 'utf8');
      return this.parseLines(content);
    } catch {
      return [];
    }
  }

  /** 会话文件路径。
   * @param sessionId 会话标识。
   * @returns 该会话对应的 .jsonl 文件绝对/相对路径。
   */
  private fileOf(sessionId: string): string {
    return join(this.directory, `${sessionId}.jsonl`);
  }

  /** 解析 JSONL 文本为事件列表。
   * @param content JSONL 全文（每行一个 JSON 对象）。
   * @returns 逐行解析出的事件数组（跳过空行）；行内容非法 JSON 时抛错（由调用方容错）。
   */
  private parseLines(content: string): readonly SessionEvent[] {
    return content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as SessionEvent);
  }
}
