/**
 * 文件版 Scratchpad 适配器（T3.4）：便签落盘 `<workspaceRoot>/.omniharness/scratchpad.json`。
 *
 * - fail-soft：文件缺失/损坏/不可写一律回空态或静默丢便签，绝不抛错阻断主流程。
 * - 有界：只保留最近 `maxNotes` 条（默认 50），交接物是热数据不是档案。
 * - workspaceRoot 以 getter 注入：支持运行时 `workspace.switch` 后写到正确的项目。
 */
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import type { ScratchpadNote, ScratchpadPort } from '../../ports/scratchpad.js';

const FILE = 'scratchpad.json';
const DIR = '.omniharness';

/** 文件 Scratchpad 选项。 */
export interface FileScratchpadOptions {
  /** 最多保留条数（默认 50）。 */
  readonly maxNotes?: number;
}

/**
 * 跨上下文重置的文件便签（T3.4 交接物）。
 * 同一工作区下的任意新实例都能读到此前写入的便签——这正是「重置后恢复任务」的机制。
 */
export class FileScratchpad implements ScratchpadPort {
  /** 适配器标识名。 */
  public readonly name = 'file-scratchpad';
  /** 工作区根（getter 注入：支持运行时切换项目）。 */
  private readonly workspaceRoot: () => string;
  /** 便签保留上限（超出丢最旧）。 */
  private readonly maxNotes: number;
  /** 本实例内自增序号（拼进 id，保证同毫秒写入不重号）。 */
  private seq = 0;

  /**
   * @param workspaceRoot 工作区根（getter 注入，支持运行时切换项目）
   * @param opts 选项（保留条数上限）
   */
  public constructor(workspaceRoot: () => string, opts: FileScratchpadOptions = {}) {
    this.workspaceRoot = workspaceRoot;
    this.maxNotes = Math.max(1, Math.floor(opts.maxNotes ?? 50));
  }

  /**
   * 追加一条便签并落盘（新条在最前）。
   * @param text 便签正文（空白正文拒收，返回 undefined）
   * @param tags 可选标签
   * @returns 落盘成功的便签；正文为空或写盘失败时返回 undefined（fail-soft）
   */
  public append(text: string, tags?: readonly string[]): ScratchpadNote | undefined {
    if (typeof text !== 'string' || text.trim() === '') return undefined;
    const note: ScratchpadNote = {
      id: `note-${Date.now()}-${this.seq++}`,
      at: new Date().toISOString(),
      text,
      ...(tags && tags.length > 0 ? { tags: [...tags] } : {}),
    };
    const notes = [note, ...this.readAll()].slice(0, this.maxNotes);
    try {
      const file = this.filePath();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(notes, null, 2) + '\n', 'utf8');
    } catch {
      return undefined; // fail-soft：写失败丢这条，不阻断
    }
    return note;
  }

  /**
   * 读最近 k 条便签（新在前）。
   * @param k 返回条数上限（默认 10；0 返回空）
   * @returns 便签列表（读失败回空数组）
   */
  public recent(k = 10): readonly ScratchpadNote[] {
    return this.readAll().slice(0, Math.max(0, k));
  }

  /**
   * 读最新一条便签——重置后恢复任务的入口。
   * @returns 最新便签；无任何便签或读失败时 undefined
   */
  public latest(): ScratchpadNote | undefined {
    return this.readAll()[0];
  }

  /**
   * 清空便签（新任务开编）。目录不存在时先创建再写空数组，保证幂等。
   * @returns 无返回值（void）；写盘失败静默（fail-soft）。
   */
  public clear(): void {
    try {
      const file = this.filePath();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '[]\n', 'utf8');
    } catch {
      // fail-soft：清空失败视为未清空
    }
  }

  /**
   * 便签文件绝对路径。
   * @returns 工作区根 × `.omniharness/scratchpad.json`
   */
  public filePath(): string {
    return join(this.workspaceRoot(), DIR, FILE);
  }

  /**
   * 读全部便签（内部）。
   * @returns 解析出的便签列表；文件缺失/损坏/非数组一律回空（fail-soft）
   */
  private readAll(): readonly ScratchpadNote[] {
    try {
      const file = this.filePath();
      if (!existsSync(file)) return [];
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (x): x is ScratchpadNote =>
          typeof x === 'object' && x !== null && typeof (x as ScratchpadNote).text === 'string',
      );
    } catch {
      return [];
    }
  }
}
