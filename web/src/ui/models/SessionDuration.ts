// 当前会话时钟（纯函数，零 React）：把「服务端有效时长」与「本回合实时增量」合成一个可读时长。
//
// 口径：
//  - 空闲：只显示服务端 `activeMs`（已剔除 >5 分钟挂机；历史会话可能没有该字段）。
//  - 回合进行中：`activeMs` + 从本回合 busy 起点到现在的墙钟增量（每秒刷新）。
//    服务端不会为未落盘的回合实时回写 activeMs，故必须加本地增量，否则计时器不动。
//  - 无 `activeMs` 且非 busy：不显示（不编造 0 秒）。
//
// 为什么单独成模型：ChatHeader 是纯展示组件；计时需要 setInterval/状态，放在展示层会把它
// 从纯组件变成有副作用的组件。这里只做纯换算，StreamView 负责 tick，ChatHeader 只画。

import { formatDurationMs } from './DurationFormat.ts';
import { t } from '../i18n/i18n.ts';

/** 时长展示态。 */
export type SessionDurationState = 'running' | 'done';

/** 时钟视图。 */
export interface SessionDurationView {
  /** 是否显示（无基准且非 running 时为 false）。 */
  readonly visible: boolean;
  /** 展示态：running=回合进行中，done=已完成。 */
  readonly state: SessionDurationState;
  /** 合成后的毫秒数（非负）。 */
  readonly elapsedMs: number;
  /** 可直接渲染的文案；visible=false 时为空串。 */
  readonly label: string;
}

/**
 * 当前会话时钟。
 */
export class SessionDuration {
  /**
   * 合成当前时长。
   * @param baseActiveMs 服务端有效时长（ms；undefined/非法按 0）。
   * @param busySince 本回合 busy 起点（ms；undefined 表示未在跑或尚未记录）。
   * @param now 当前时刻（ms）。
   * @param busy 本回合是否进行中。
   * @returns 视图（不可显示时 visible=false）。
   */
  public static view(
    baseActiveMs: number | undefined,
    busySince: number | undefined,
    now: number,
    busy: boolean,
  ): SessionDurationView {
    const base =
      typeof baseActiveMs === 'number' && Number.isFinite(baseActiveMs) && baseActiveMs > 0
        ? Math.floor(baseActiveMs)
        : 0;
    const live =
      busy && busySince !== undefined && Number.isFinite(busySince)
        ? Math.max(0, Math.floor(now - busySince))
        : 0;
    const elapsedMs = base + live;
    if (!busy && elapsedMs <= 0) {
      return { visible: false, state: 'done', elapsedMs: 0, label: '' };
    }
    const duration = formatDurationMs(elapsedMs);
    const state: SessionDurationState = busy ? 'running' : 'done';
    const label = busy
      ? t('进行中，用时 {duration}', { duration })
      : t('已完成，用时 {duration}', { duration });
    return { visible: true, state, elapsedMs, label };
  }
}
