/**
 * 定时任务调度器（D3）：纯 TS、零依赖。
 *
 * 调度支持两种形式：
 * - interval：每 N 分钟跑一次（适合「周期性巡检」）。
 * - cron：5 段标准 cron 表达式（分 时 日 月 周），支持 * , - /（步长）。
 *
 * 持久化到 routines.json；`runDue(now)` 返回本次应立即执行的任务（按 lastRun 防同分钟重复）。
 * 执行动作（真正跑 Agent）由 CLI 层负责，本模块只负责「何时该跑」的判定与存储。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * @beta
 */
export type RoutineModelAdapter = 'mock' | 'openai' | 'anthropic' | 'responses' | 'llamacpp';

/**
 * @beta
 */
export type RoutineSchedule =
  | { readonly kind: 'interval'; readonly minutes: number }
  | { readonly kind: 'cron'; readonly expr: string };

/**
 * @beta
 */
export interface Routine {
  readonly name: string;
  readonly prompt: string;
  readonly modelAdapter: RoutineModelAdapter;
  readonly schedule: RoutineSchedule;
  /** 上次执行时间戳（ms）；未执行过为 undefined。 */
  readonly lastRun?: number;
}

function defaultStorePath(): string {
  return resolve(homedir(), '.omniharness', 'routines.json');
}

/** 把单段 cron 字段（如「每5分」「1-3,9」「任意」）展开为命中的数值集合。 */
function expandField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let v = min; v <= max; v += 1) out.add(v);
      continue;
    }
    let step = 1;
    let range = part;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      step = Number.parseInt(part.slice(slash + 1), 10);
      if (Number.isNaN(step) || step < 1) step = 1;
      range = part.slice(0, slash);
    }
    let lo = min;
    let hi = max;
    const dash = range.indexOf('-');
    if (dash >= 0) {
      lo = Number.parseInt(range.slice(0, dash), 10);
      hi = Number.parseInt(range.slice(dash + 1), 10);
    } else if (range !== '*') {
      lo = Number.parseInt(range, 10);
      hi = lo;
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
    lo = Math.max(min, lo);
    hi = Math.min(max, hi);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * @beta
 * 判定 cron 表达式是否命中给定时间（同分钟只算一次）。
 */
export function matchesCron(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const minute = expandField(fields[0] ?? '*', 0, 59);
  const hour = expandField(fields[1] ?? '*', 0, 23);
  const dom = expandField(fields[2] ?? '*', 1, 31);
  const month = expandField(fields[3] ?? '*', 1, 12);
  const dow = expandField(fields[4] ?? '*', 0, 6);
  if (!minute.has(date.getMinutes())) return false;
  if (!hour.has(date.getHours())) return false;
  if (!month.has(date.getMonth() + 1)) return false;
  // 日/周：cron 约定「日或周命中即触发」（取并集）。
  const domHit = dom.has(date.getDate());
  const dowHit = dow.has(date.getDay());
  if (!domHit && !dowHit) return false;
  return true;
}

/**
 * @beta
 * 定时任务调度器（含持久化）。
 */
export class RoutineScheduler {
  private readonly storePath: string;

  constructor(storePath: string = defaultStorePath()) {
    this.storePath = storePath;
  }

  /** 列出全部任务。 */
  list(): Routine[] {
    const store = this.load();
    return [...store.routines];
  }

  /** 新增/覆盖任务（按 name 幂等）。 */
  add(routine: Routine): void {
    const store = this.load();
    const idx = store.routines.findIndex((r) => r.name === routine.name);
    if (idx >= 0) {
      // 保留原有 lastRun，避免覆盖后丢失进度。
      store.routines[idx] = { ...routine, lastRun: store.routines[idx]?.lastRun };
    } else {
      store.routines.push(routine);
    }
    this.save(store);
  }

  /** 删除任务；不存在返回 false。 */
  remove(name: string): boolean {
    const store = this.load();
    const before = store.routines.length;
    store.routines = store.routines.filter((r) => r.name !== name);
    if (store.routines.length === before) return false;
    this.save(store);
    return true;
  }

  /** 标记任务已执行（更新 lastRun）。 */
  markRun(name: string, at: number): void {
    const store = this.load();
    const exists = store.routines.some((r) => r.name === name);
    if (!exists) return;
    store.routines = store.routines.map((r) => (r.name === name ? { ...r, lastRun: at } : r));
    this.save(store);
  }

  /** 返回截至 now 应执行的任务（interval 到期 / cron 命中且距上次≥1 分钟）。 */
  runDue(now: number = Date.now()): Routine[] {
    const store = this.load();
    const due: Routine[] = [];
    for (const routine of store.routines) {
      if (this.isDue(routine, now)) {
        due.push(routine);
      }
    }
    return due;
  }

  /** 单任务判定。 */
  private isDue(routine: Routine, now: number): boolean {
    if (routine.lastRun !== undefined && now - routine.lastRun < 60_000) {
      return false; // 同分钟内不重复触发。
    }
    if (routine.schedule.kind === 'interval') {
      const gap = routine.schedule.minutes * 60_000;
      if (routine.lastRun === undefined) return true;
      return now - routine.lastRun >= gap;
    }
    return matchesCron(routine.schedule.expr, new Date(now));
  }

  private load(): { routines: Routine[] } {
    if (!existsSync(this.storePath)) {
      return { routines: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.storePath, 'utf8')) as { routines?: Routine[] };
      return { routines: Array.isArray(parsed.routines) ? parsed.routines : [] };
    } catch {
      return { routines: [] };
    }
  }

  private save(store: { routines: Routine[] }): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(this.storePath, JSON.stringify(store, null, 2), 'utf8');
  }
}
