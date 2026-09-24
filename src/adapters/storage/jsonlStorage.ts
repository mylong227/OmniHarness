import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEvent } from '../../ports/runtime/event.js';
import type { StoragePort } from '../../ports/memory/storage.js';
import { log } from '../../util/logger.js';

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

  /**
   * 保存会话事件（整文件覆盖写，但**原子**：先写 `<file>.tmp` 再 `rename` 覆盖）。
   *
   * 为什么必须原子（审计 §1.7）：整文件 `writeFile` 覆盖到一半崩溃/断电，会留下**半截文件**——
   * 下一次 `load` 要么解析失败、要么（更糟）读到一个看似完整却缺尾的历史，而调用方无从分辨。
   * `rename` 在同一目录内是原子的：读方要么看到旧的完整文件，要么看到新的完整文件。
   * 代价是一次额外写与 rename，对「每回合数百次」的落盘频率可忽略。
   * @param sessionId 会话标识（决定目标文件名）。
   * @param events 完整事件列表（末尾补换行）。
   * @returns 无返回值。
   */
  public async save(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    const file = this.fileOf(sessionId);
    await mkdir(this.directory, { recursive: true });
    const lines = events.map((event) => JSON.stringify(event)).join('\n');
    const tmp = `${file}.tmp`;
    try {
      await writeFile(tmp, `${lines}\n`, 'utf8');
      await rename(tmp, file);
    } catch (err) {
      // 失败时清掉半成品，避免下次 load 读到 .tmp（它不参与读取，但会一直堆积）。
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  /**
   * 加载会话事件。
   *
   * **坏行不再导致「静默空历史」**（审计 §1.7）：原实现把整文件 `JSON.parse` 放在同一个 try 里，
   * 一行非法 JSON 就让 `load` 落到 `catch` 返回 `[]`——调用方无法区分「没有历史」与「历史读不出来」，
   * 表现为会话回放/续跑**悄悄丢光全部上下文**。现改为：
   *  - 文件不存在 ⇒ 空数组（正常的「无历史」）；
   *  - 其它读取错误 ⇒ warn + 空数组（不抛错，保持原契约，但**不再无声**）；
   *  - 个别坏行 ⇒ **跳过该行并 warn**（带行号），其余事件照常返回（能救多少救多少）；
   *  - 有内容但**全部**行都解析失败 ⇒ 额外 warn 一条 `all_lines_corrupt`（这是文件级损坏的信号）。
   * @param sessionId 会话标识。
   * @returns 成功解析出的事件列表（按文件行序）；文件缺失/不可读时为空数组（不抛错）。
   */
  public async load(sessionId: string): Promise<readonly SessionEvent[]> {
    const file = this.fileOf(sessionId);
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('storage.jsonl.unreadable', { sessionId, file, error: String(err) });
      }
      return [];
    }
    return this.parseLines(content, sessionId, file);
  }

  /** 会话文件路径。
   * @param sessionId 会话标识。
   * @returns 该会话对应的 .jsonl 文件绝对/相对路径。
   */
  private fileOf(sessionId: string): string {
    return join(this.directory, `${sessionId}.jsonl`);
  }

  /**
   * 解析 JSONL 文本为事件列表：逐行解析，**坏行跳过并告警**（不放弃整份历史）。
   * @param content JSONL 全文（每行一个 JSON 对象）。
   * @param sessionId 会话标识（仅用于告警归因）。
   * @param file 文件路径（仅用于告警归因）。
   * @returns 逐行解析出的事件数组（跳过空行与坏行）。
   */
  private parseLines(content: string, sessionId: string, file: string): readonly SessionEvent[] {
    const events: SessionEvent[] = [];
    let bad = 0;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (line.trim() === '') {
        continue;
      }
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch (err) {
        bad += 1;
        log.warn('storage.jsonl.bad_line', {
          sessionId,
          file,
          line: i + 1,
          error: String(err),
        });
      }
    }
    if (bad > 0 && events.length === 0) {
      // 有内容却一行都解析不出来 ⇒ 文件级损坏（截断/换行被破坏/编码错），单独记一条便于告警聚合。
      log.warn('storage.jsonl.all_lines_corrupt', { sessionId, file, lines: bad });
    }
    return events;
  }
}
