/**
 * 会话事件源适配器（会话存档 JSONL → `SessionEvent[]`）——只读 trace 自省的事件源实现。
 *
 * 背景（2026-09-19 入口可达性审计）：`ReadonlyTraceReader` / `TraceIntrospectionPort` 有实现、
 * 有单测，却在生产路径上**无人调用**——「agent 自省我刚做了什么」缺的就是「事件从哪来」这一环。
 * 本适配器把生产侧真实落盘的会话存档（每会话一个 `<sessionId>.jsonl`，见 `JsonlStorage` /
 * `SessionArchive`）读成事件流，供 `SessionTraceService` 注入进只读读取器。
 *
 * - **只读**：仅 `readFile`，绝不写、不建目录、不改动存档；返回深拷贝式的新数组。
 * - **fail-soft**：文件缺失 / 不可读 / 行损坏一律回空数组（不抛错），由调用方判定「会话无 trace」。
 * - **路径安全**：会话 id 先按 `^[A-Za-z0-9_-]{1,128}$` 校验，阻断 `../` 之类的路径穿越。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEvent } from '../../ports/runtime/event.js';

/** 合法的会话 id 形态（与 `SessionArchive.resolveSessionFile` 同一口径）。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 会话事件源（会话 id → 事件流）。
 */
export interface SessionEventReaderPort {
  /**
   * 读取某会话的全部事件。
   * @param sessionId 会话 id（须匹配 `^[A-Za-z0-9_-]{1,128}$`）
   * @returns 事件流（文件序）；id 非法 / 文件缺失 / 不可读 / 损坏时为空数组
   */
  load(sessionId: string): Promise<readonly SessionEvent[]>;
}

/**
 * JSONL 会话存档事件源：`<storageDir>/<sessionId>.jsonl` 逐行解析为 `SessionEvent`。
 */
export class SessionEventReader implements SessionEventReaderPort {
  /** 存储根目录（jsonl 后端为目录；相对路径按进程工作目录解析）。 */
  private readonly storageDir: string;

  /**
   * @param storageDir 存储根目录（如 CLI `--storage-dir`；相对路径按进程工作目录解析）
   */
  public constructor(storageDir: string) {
    this.storageDir = storageDir;
  }

  /**
   * 读取并解析会话存档。
   * @param sessionId 会话 id（非法形态直接回空，不做任何路径拼接）
   * @returns 事件流；文件缺失 / 不可读 / 无有效行时为空数组
   */
  public async load(sessionId: string): Promise<readonly SessionEvent[]> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return [];
    }
    let text: string;
    try {
      text = await readFile(join(this.storageDir, `${sessionId}.jsonl`), 'utf8');
    } catch {
      return [];
    }
    const events: SessionEvent[] = [];
    for (const line of text.split('\n')) {
      const parsed = SessionEventReader.parseLine(line);
      if (parsed !== undefined) {
        events.push(parsed);
      }
    }
    return events;
  }

  /**
   * 解析单行 JSONL 为会话事件（非法行回 undefined，不抛错）。
   * @param line 原始单行文本
   * @returns 会话事件（未声明 id/sessionId 的行按文件序补位）；空行 / 坏行 / 缺 type/timestamp 时 undefined
   */
  private static parseLine(line: string): SessionEvent | undefined {
    if (line.trim() === '') {
      return undefined;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
    if (raw === null || typeof raw !== 'object') {
      return undefined;
    }
    const rec = raw as Record<string, unknown>;
    const type = rec['type'];
    const timestamp = rec['timestamp'];
    if (typeof type !== 'string' || type === '' || typeof timestamp !== 'string') {
      return undefined;
    }
    return {
      id: typeof rec['id'] === 'string' ? rec['id'] : `line-${String(rec['seq'] ?? '')}`,
      type: type as SessionEvent['type'],
      sessionId: typeof rec['sessionId'] === 'string' ? rec['sessionId'] : '',
      timestamp,
      payload: rec['payload'],
    };
  }
}
