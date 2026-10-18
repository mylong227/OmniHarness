import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WorkflowMemoryEntry, WorkflowMemoryPort } from '../../ports/memory/workflowMemory.ts';

/** 存储选项。 */
export interface WorkflowMemoryStoreOptions {
  /** 最多保留条数（默认 100）。 */
  readonly maxEntries?: number;
  /** 可注入时钟。 */
  readonly now?: (() => Date) | undefined;
  /** 可注入路径。 */
  readonly path?: string | undefined;
}

/**
 * 文件版 workflow memory（工作区内 JSONL；有界；按任务词重叠召回）。
 *
 * 诚实边界：这是**检索式**记忆，不是自动重放器；命中只作为提示给模型参考，
 * 工具参数/副作用仍需模型重新判断。
 */
export class WorkflowMemoryStore implements WorkflowMemoryPort {
  /** 最多保留条数。 */
  private readonly maxEntries: number;
  /** 时钟。 */
  private readonly now: () => Date;
  /** 存储路径。 */
  private readonly path: string;

  /**
   * @param workspaceRoot 工作区根。
   * @param options 存储选项。
   */
  public constructor(workspaceRoot: string, options: WorkflowMemoryStoreOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 100));
    this.now = options.now ?? (() => new Date());
    this.path = options.path ?? join(workspaceRoot, '.omniharness', 'workflows.jsonl');
  }

  /**
   * 记录一条成功 workflow（同任务 + 同步骤去重）。
   * @param task 任务描述
   * @param steps 工具步骤
   * @returns 无返回值
   */
  public async remember(task: string, steps: readonly string[]): Promise<void> {
    const normalizedTask = task.trim().slice(0, 2_000);
    const normalizedSteps = steps
      .map((step) => step.trim())
      .filter((step) => step !== '')
      .slice(0, 50);
    if (normalizedTask === '' || normalizedSteps.length === 0) return;
    const entries = await this.read();
    if (
      entries.some(
        (entry) =>
          entry.task === normalizedTask &&
          WorkflowMemoryStore.sameSteps(entry.steps, normalizedSteps),
      )
    ) {
      return;
    }
    entries.push({
      id: randomUUID(),
      task: normalizedTask,
      steps: normalizedSteps,
      at: this.now().toISOString(),
    });
    await this.write(entries.slice(-this.maxEntries));
  }

  /**
   * 按任务词重叠召回。
   * @param task 当前任务
   * @param limit 最多条数
   * @returns 相似条目（score 高者优先）
   */
  public async recall(task: string, limit = 3): Promise<readonly WorkflowMemoryEntry[]> {
    const query = WorkflowMemoryStore.tokensOf(task);
    if (query.size === 0) return [];
    const max = Math.min(5, Math.max(1, Math.floor(limit)));
    const scored = (await this.read())
      .map((entry) => ({
        entry,
        score: WorkflowMemoryStore.overlap(query, WorkflowMemoryStore.tokensOf(entry.task)),
      }))
      .filter((item) => item.score > 0)
      .sort(
        (left, right) => right.score - left.score || right.entry.at.localeCompare(left.entry.at),
      )
      .slice(0, max)
      .map((item) => item.entry);
    return scored;
  }

  /**
   * 读取条目（坏行跳过）。
   * @returns 条目数组
   */
  private async read(): Promise<WorkflowMemoryEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return [];
    }
    const out: WorkflowMemoryEntry[] = [];
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line) as WorkflowMemoryEntry;
        if (WorkflowMemoryStore.isEntry(row)) out.push(row);
      } catch {
        // 坏行跳过：记忆是增强，不是主状态。
      }
    }
    return out;
  }

  /**
   * 原子写入。
   * @param entries 条目
   * @returns 无返回值
   */
  private async write(entries: readonly WorkflowMemoryEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(
      tmp,
      entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''),
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
    await rename(tmp, this.path);
  }

  /**
   * 任务分词：小写字母/数字/下划线与 CJK 字符。
   * @param text 任务文本
   * @returns 词集合
   */
  private static tokensOf(text: string): Set<string> {
    const normalized = text.toLowerCase();
    const words = normalized.split(/[^\p{L}\p{N}_]+/u).filter((word) => word !== '');
    const tokens = new Set(words);
    // 中文没有空格：把 CJK 连续段按 2-gram 补进去，避免「修复登录」与「登录修复」零重叠。
    for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
      const chars = Array.from(match[0]);
      for (let index = 0; index < chars.length - 1; index += 1) {
        tokens.add(`${chars[index] ?? ''}${chars[index + 1] ?? ''}`);
      }
    }
    return tokens;
  }

  /**
   * 词集合重叠分（Jaccard 近似）。
   * @param left 查询词
   * @param right 条目词
   * @returns 0..1
   */
  private static overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
    if (left.size === 0 || right.size === 0) return 0;
    let shared = 0;
    for (const token of left) if (right.has(token)) shared += 1;
    return shared / new Set([...left, ...right]).size;
  }

  /**
   * 步骤序列是否相同。
   * @param left 左
   * @param right 右
   * @returns 相同为 true
   */
  private static sameSteps(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((step, index) => step === right[index]);
  }

  /**
   * 形状校验。
   * @param value 反序列化值
   * @returns 可用时 true
   */
  private static isEntry(value: unknown): value is WorkflowMemoryEntry {
    if (typeof value !== 'object' || value === null) return false;
    const row = value as Partial<WorkflowMemoryEntry>;
    return (
      typeof row.id === 'string' &&
      typeof row.task === 'string' &&
      Array.isArray(row.steps) &&
      row.steps.every((step) => typeof step === 'string') &&
      typeof row.at === 'string'
    );
  }
}
