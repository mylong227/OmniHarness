import type { SessionEvent } from '../runtime/event.js';

/** 存储端口：会话事件持久化的统一插口（可换后端：内存/文件/SQLite/云）。 */
export interface StoragePort {
  readonly name: string;
  /** 后端物理位置（文件目录 / SQLite 库路径）；内存等无落盘后端为 undefined。 */
  readonly location?: string;
  save(sessionId: string, events: readonly SessionEvent[]): Promise<void>;
  load(sessionId: string): Promise<readonly SessionEvent[]>;
}
