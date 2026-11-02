// 会话时钟 + 「回合刚收尾」回闪窗口（2026-11-02 从 StreamView 下沉）。
//
// 为什么单独成 hook：`StreamView` 的职责是「事件 → 可视块」的编排；计时（每秒 tick）、
// 回合起点冻结、切会话重取基准都是自包含的副作用，混在组件体里既撑大函数体
// （check.mjs 铁律 80 行），也让「渲染」与「计时」两件事互相纠缠。
//
// 口径（与下沉前**逐字一致**，勿改）：
//   · busy 期间每秒 tick；`busyBaseRef` 冻结本回合开始前的服务端累计时长，
//     避免中途 refresh 把当前回合计两次；
//   · 切会话（threadId 变化）也要重取 busy 起点（否则新会话继承旧回合的计时）；
//   · busy true→false 记下收尾时刻，1.5s 内的过程簇给一次「回闪」高亮
//     （CSS animation 无 forwards，播完自动回落透明底，类名残留无副作用）。

import * as React from 'react';
import { SessionDuration } from '../../models/SessionDuration.ts';
import type { SessionDurationView } from '../../models/SessionDuration.ts';

/** 「刚收尾」回闪窗口（ms）：超过即不再给过程簇加高亮。 */
const CLUSTER_FRESH_MS = 1500;

/** `useSessionClock` 的产物。 */
export interface SessionClockState {
  /** 中栏头展示的会话时长视图（visible=false 时不显示）。 */
  readonly sessionClock: SessionDurationView;
  /** 是否「刚收尾」（busy true→false 后 1.5s 内）。 */
  readonly clusterFresh: boolean;
}

/**
 * 会话时钟：把「服务端有效时长 + 本回合实时增量」合成可读时长，并给出「刚收尾」判定。
 * @param sessionActiveMs 服务端有效时长（ms；undefined 表示历史会话没有该字段）
 * @param busy 本回合是否进行中
 * @param threadId 当前会话 id（变化即重取计时基准）
 * @returns 时长视图 + 是否刚收尾
 */
export function useSessionClock(
  sessionActiveMs: number | undefined,
  busy: boolean | undefined,
  threadId: string | null | undefined,
): SessionClockState {
  /** 当前会话时钟：每秒 tick 一次；busySince 记录本回合开始（undefined=未在跑）。 */
  const [clockNow, setClockNow] = React.useState<number>(() => Date.now());
  const [busySince, setBusySince] = React.useState<number | undefined>(undefined);
  /** 本回合开始时服务端已累计时长（busy 期间冻结，避免中途 refresh 把当前回合计两次）。 */
  const busyBaseRef = React.useRef<number>(0);
  const sessionActiveMsRef = React.useRef<number | undefined>(sessionActiveMs);
  sessionActiveMsRef.current = sessionActiveMs;
  const prevBusyForClockRef = React.useRef<boolean | undefined>(busy);
  const prevThreadForClockRef = React.useRef<string | null | undefined>(threadId);
  React.useEffect(() => {
    const switched = prevThreadForClockRef.current !== threadId;
    prevThreadForClockRef.current = threadId;
    if (busy === true) {
      if (prevBusyForClockRef.current !== true || switched) {
        busyBaseRef.current =
          typeof sessionActiveMsRef.current === 'number' && sessionActiveMsRef.current > 0
            ? sessionActiveMsRef.current
            : 0;
        setBusySince(Date.now());
        setClockNow(Date.now());
      }
      const timer = setInterval(() => setClockNow(Date.now()), 1000);
      prevBusyForClockRef.current = true;
      return () => clearInterval(timer);
    }
    setBusySince(undefined);
    setClockNow(Date.now());
    prevBusyForClockRef.current = false;
    return undefined;
  }, [busy, threadId]);
  const sessionClock = SessionDuration.view(
    busy === true ? busyBaseRef.current : sessionActiveMs,
    busySince,
    clockNow,
    busy === true,
  );
  /** 回合收尾时刻（busy true→false）：过程簇此刻挂载，给它一次「回闪」高亮。0=无；
   *  历史加载不经此路径（恒 0，不闪）。 */
  const [settledAt, setSettledAt] = React.useState<number>(0);
  const prevBusyRef = React.useRef<boolean | undefined>(busy);
  React.useEffect(() => {
    if (prevBusyRef.current === true && busy !== true) setSettledAt(Date.now());
    prevBusyRef.current = busy;
  }, [busy]);
  // 收尾后 1.5s 内视为「刚收尾」。
  const clusterFresh = settledAt !== 0 && busy !== true && Date.now() - settledAt < CLUSTER_FRESH_MS;
  return { sessionClock, clusterFresh };
}
