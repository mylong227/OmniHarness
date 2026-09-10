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
}
