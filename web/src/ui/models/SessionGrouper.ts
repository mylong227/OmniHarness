// 会话分组：把扁平会话列表按「所属工作区」折叠成分组，并决定分组展示顺序。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。

import { PathJoiner } from './PathJoiner.js';

/** 无工作区标记的历史会话归入此键（升级前创建的会话）。 */
export const EARLY_KEY = '__early__';

/** 一个会话分组。 */
export interface SessionGroup<T> {
  /** 分组键：规范化后的工作区路径，或 EARLY_KEY。 */
  key: string;
  /** 展示名：末段目录名，早期会话为固定文案。 */
  name: string;
  items: T[];
}

/** 具备工作区标记的会话条目（结构化子类型，避免依赖完整 SessionEntry）。 */
interface WorkspaceTagged {
  workspace?: string;
}

/** 时间分组键（Codex 式左栏：今天 / 昨天 / 更早；归档会话单独一组）。 */
export type TimeBucketKey = 'today' | 'yesterday' | 'earlier' | 'archived';

/** 一个时间分组。 */
export interface TimeGroup<T> {
  /** 桶键。 */
  key: TimeBucketKey;
  /** 展示名（今天 / 昨天 / 更早）。 */
  name: string;
  items: T[];
}

/** 具备时间戳的会话条目。 */
interface TimeTagged {
  updatedAt?: string;
}

/** 具备归档标记的会话条目。 */
interface ArchivedTagged {
  archived?: boolean;
}

/** 桶展示名（顺序即分组顺序；归档垫底）。 */
const TIME_BUCKET_NAMES: ReadonlyArray<{ key: TimeBucketKey; name: string }> = [
  { key: 'today', name: '今天' },
  { key: 'yesterday', name: '昨天' },
  { key: 'earlier', name: '更早' },
  { key: 'archived', name: '已归档' },
];

/** 会话分组器。 */
export class SessionGrouper {
  /**
   * 分组并排序：当前工作区组排最前，其余按原顺序，「更早会话」组垫底。
   * 未标记工作区的会话一律归入 EARLY_KEY（fail-closed 到可见分组，而非丢弃）。
   */
  public static group<T extends WorkspaceTagged>(sessions: readonly T[], currentWsPath: string): SessionGroup<T>[] {
    const currentKey = PathJoiner.normalize(currentWsPath);
    const byKey = new Map<string, T[]>();
    for (const s of sessions) {
      const key = s.workspace ? PathJoiner.normalize(s.workspace) : EARLY_KEY;
      const list = byKey.get(key);
      if (list) list.push(s);
      else byKey.set(key, [s]);
    }
    const orderedKeys: string[] = [];
    if (currentKey !== '' && byKey.has(currentKey)) orderedKeys.push(currentKey);
    for (const k of byKey.keys()) {
      if (k !== currentKey && k !== EARLY_KEY) orderedKeys.push(k);
    }
    if (byKey.has(EARLY_KEY)) orderedKeys.push(EARLY_KEY);
    return orderedKeys.map((key) => ({
      key,
      name: key === EARLY_KEY ? '更早会话（未标记项目）' : PathJoiner.basename(key),
      items: byKey.get(key) ?? [],
    }));
  }

  /**
   * 按**本地日历日**把会话分「今天 / 昨天 / 更早」三桶（Codex 式左栏的组织方式）。
   *
   * 口径与边界：
   * - 用 `updatedAt`（ISO 字符串）判定；**解析不出来或缺失的一律进「更早」**（fail-closed 到可见
   *   分组，不丢行）；
   * - 比较的是**本地日**（`getFullYear/Month/Date`），不是 UTC 日 —— 用户看到的「今天」应与系统
   *   日历一致；跨时区/夏令时由 `Date` 自行处理；
   * - 组内保持输入顺序（列表已按更新时间倒序），空桶不产出。
   * @param sessions 会话条目（需带 `updatedAt`）
   * @param now 参照时刻（毫秒；缺省取当前时间，单测注入以获得确定性）
   * @returns 非空的时间分组（顺序：今天 → 昨天 → 更早）
   */
  public static groupByTime<T extends TimeTagged & ArchivedTagged>(
    sessions: readonly T[],
    now: number = Date.now(),
  ): TimeGroup<T>[] {
    const ref = new Date(now);
    const refDay = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
    const DAY = 24 * 60 * 60 * 1000;
    const buckets: Record<TimeBucketKey, T[]> = { today: [], yesterday: [], earlier: [], archived: [] };
    for (const s of sessions) {
      // 归档会话单独成组（排在最后）：它们仍可见可恢复，但不再混在今天/昨天的日常流里。
      if (s.archived === true) {
        buckets.archived.push(s);
        continue;
      }
      const t = SessionGrouper.dayStartOf(s.updatedAt);
      const key: TimeBucketKey =
        t === undefined || t < refDay - DAY ? 'earlier' : t >= refDay ? 'today' : 'yesterday';
      buckets[key].push(s);
    }
    return TIME_BUCKET_NAMES.filter((b) => buckets[b.key].length > 0).map((b) => ({
      key: b.key,
      name: b.name,
      items: buckets[b.key],
    }));
  }

  /**
   * 把 `updatedAt` 归到**本地日的零点**（解析失败返回 undefined）。
   * @param updatedAt ISO 时间字符串（可缺省）
   * @returns 本地日零点毫秒；缺失/非法返回 undefined
   */
  private static dayStartOf(updatedAt: string | undefined): number | undefined {
    if (updatedAt === undefined || updatedAt === '') return undefined;
    const d = new Date(updatedAt);
    const ms = d.getTime();
    if (Number.isNaN(ms)) return undefined;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
}
