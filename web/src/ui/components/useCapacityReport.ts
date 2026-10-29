// 左栏容量小图表（CapacityDock）的取数 hook。
//
// 2026-10-28 用户把容量入口收口到左栏底部（控制台详情页已撤）：小图表**常驻**，因此刷新语义是：
//   · `sessionTick`：会话事件去抖后 +1（切会话、回合推进）——常驻时只靠它，不跑定时器；
//   · `active`（浮层展开）：才开 5s 兜底，补配额重置/时间敏感字段这类"没有事件但会变"的量。
//
// 依赖数组刻意只放**语义量**（字符串/数字/稳定实例）：2026-10-06 曾把内联回调塞进依赖，
// 导致面板打开 6 秒打了 23 次 /rpc。此处 `api` 来自 AppContext（控制器单例），身份稳定。

import * as React from 'react';
import { useApp } from '../context.ts';
import type { ContextUsageReport, QuotaStatus } from '../../types/models.ts';

/** 兜底刷新间隔（毫秒）：介于"实时"与"别回放事件日志"之间。 */
export const CAPACITY_POLL_MS = 5000;

/** 容量面板的数据状态。 */
export interface CapacityReportState {
  /** 上下文用量快照（首次取数前为 undefined）。 */
  readonly usage: ContextUsageReport | undefined;
  /** 今日配额（首次取数前为 undefined）。 */
  readonly quota: QuotaStatus | undefined;
  /** 是否正在取数。 */
  readonly loading: boolean;
  /** 最近一次取数失败的原因（成功即清空）。 */
  readonly error: string | null;
  /** 手动重试。 */
  readonly reload: () => void;
}

/**
 * 订阅当前会话的容量与配额。
 * @param active 是否处于"正在看"的状态（浮层展开）；为 false 时**不跑 5s 轮询**，
 *   只在挂载与 `sessionTick` 变化时取数——左栏常驻小图表不能每 5s 回放一次事件日志。
 * @returns 数据、加载/错误状态与重试入口
 */
export function useCapacityReport(active: boolean = true): CapacityReportState {
  const { api, sessionId, sessionTick } = useApp();
  const [usage, setUsage] = React.useState<ContextUsageReport | undefined>(undefined);
  const [quota, setQuota] = React.useState<QuotaStatus | undefined>(undefined);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState<number>(0);

  // 兜底轮询：只在浮层展开时走。
  React.useEffect(() => {
    if (!active) return undefined;
    if (typeof window.setInterval !== 'function') return undefined;
    const timer = window.setInterval(() => setTick((t) => t + 1), CAPACITY_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [active]);

  React.useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      setLoading(true);
      try {
        const [u, q] = await Promise.all([api.contextUsage(sessionId ?? ''), api.quotaGet()]);
        if (!alive) return;
        setUsage(u);
        setQuota(q);
        setError(null);
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
        setLoading(false);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [api, sessionId, sessionTick, tick]);

  const reload = React.useCallback((): void => setTick((t) => t + 1), []);
  return { usage, quota, loading, error, reload };
}
