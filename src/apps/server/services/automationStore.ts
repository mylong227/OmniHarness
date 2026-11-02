/** 自动化任务持久化（用户级 `~/.omniharness/automations.json`）。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 一条自动化任务。 */
export interface Automation {
  /** 稳定 id。 */
  readonly id: string;
  /** 名称。 */
  readonly name: string;
  /** 触发时发送的提示词。 */
  readonly prompt: string;
  /** 间隔分钟（5–1440）。 */
  readonly intervalMinutes: number;
  /** 是否启用。 */
  enabled: boolean;
  /** 创建时间（ISO）。 */
  readonly createdAt: string;
  /** 上次触发时间（ISO；从未触发缺省）。 */
  lastRunAt?: string;
}

/** 自动化任务存储。 */
export class AutomationStore {
  /** JSON 文件路径。 */
  private readonly file: string;
  /** 时钟（测试注入）。 */
  private readonly now: () => number;
  /** 内存任务表（写盘后仍以它为准）。 */
  private items: Automation[];

  /**
   * @param file JSON 文件路径
   * @param now 时钟（测试注入）
   */
  public constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    this.items = this.load();
  }

  /**
   * 全部任务（保持创建顺序）。
   * @returns 副本
   */
  public list(): Automation[] {
    return this.items.map((item) => ({ ...item }));
  }

  /**
   * 按 id 取任务。
   * @param id 任务 id
   * @returns 任务或 undefined
   */
  public get(id: string): Automation | undefined {
    const item = this.items.find((x) => x.id === id);
    return item === undefined ? undefined : { ...item };
  }

  /**
   * 创建任务。
   * @param input 原始输入
   * @returns 新任务
   */
  public create(input: unknown): Automation {
    if (input === null || typeof input !== 'object') throw new Error('invalid automation');
    const raw = input as Record<string, unknown>;
    const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
    const prompt = typeof raw['prompt'] === 'string' ? raw['prompt'].trim() : '';
    const intervalMinutes = Number(raw['intervalMinutes']);
    if (name === '' || name.length > 80) throw new Error('自动化名称必须为 1–80 字符');
    if (prompt === '' || prompt.length > 8000) throw new Error('自动化提示词必须为 1–8000 字符');
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
      throw new Error('自动化间隔必须为 5–1440 分钟');
    }
    const item: Automation = {
      id: `auto_${randomUUID()}`,
      name,
      prompt,
      intervalMinutes,
      enabled: raw['enabled'] !== false,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.items = [...this.items, item];
    this.persist();
    return { ...item };
  }

  /**
   * 删除任务。
   * @param id 任务 id
   * @returns 是否删除
   */
  public delete(id: string): boolean {
    const next = this.items.filter((x) => x.id !== id);
    if (next.length === this.items.length) return false;
    this.items = next;
    this.persist();
    return true;
  }

  /**
   * 启停任务。
   * @param id 任务 id
   * @param enabled 是否启用
   * @returns 更新后的任务；不存在为 undefined
   */
  public setEnabled(id: string, enabled: boolean): Automation | undefined {
    const item = this.items.find((x) => x.id === id);
    if (item === undefined) return undefined;
    item.enabled = enabled;
    this.persist();
    return { ...item };
  }

  /**
   * 标记已触发。
   * @param id 任务 id
   * @returns 无返回值
   */
  public markRun(id: string): void {
    const item = this.items.find((x) => x.id === id);
    if (item === undefined) return;
    item.lastRunAt = new Date(this.now()).toISOString();
    this.persist();
  }

  /**
   * 到期任务。
   * @param nowMs 当前毫秒（测试注入）
   * @returns 到期任务
   */
  public due(nowMs: number = this.now()): Automation[] {
    return this.list().filter((item) => {
      if (!item.enabled) return false;
      const base = Date.parse(item.lastRunAt ?? item.createdAt);
      if (Number.isNaN(base)) return false;
      return nowMs - base >= item.intervalMinutes * 60_000;
    });
  }

  /**
   * 读文件（容错 BOM/损坏；损坏时按空处理）。
   * @returns 任务列表
   */
  private load(): Automation[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/u, '')) as unknown;
      if (raw === null || typeof raw !== 'object') return [];
      const items = (raw as { automations?: unknown }).automations;
      if (!Array.isArray(items)) return [];
      return items
        .filter((x): x is Automation => {
          if (x === null || typeof x !== 'object') return false;
          const r = x as Record<string, unknown>;
          return (
            typeof r['id'] === 'string' &&
            typeof r['name'] === 'string' &&
            typeof r['prompt'] === 'string' &&
            typeof r['intervalMinutes'] === 'number' &&
            typeof r['enabled'] === 'boolean' &&
            typeof r['createdAt'] === 'string'
          );
        })
        .map((x) => ({ ...x }));
    } catch {
      return [];
    }
  }

  /**
   * 原子写盘。
   * @returns 无返回值
   */
  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ automations: this.items }, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}
