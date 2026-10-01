import type { PendingHandlers } from './pendingHandlers.js';

/**
 * 可选超时：到点后表**先移出条目并清定时器**，再把处理器交给 `onTimeout`，
 * 由调用方决定 reject（超时即错）或 resolve（如审批超时按 deny 兑现）。
 *
 * 已从 `util/pendingRequests.ts` 外迁到 ports/util：原文件退化为纯再导出桶，调用点零改动。
 * `PendingHandlers` 因被本接口依赖且同处一文件，一并迁入（ports 内闭包，断 `ports↔impl` 双向环）。
 */
export interface PendingTimeout<T> {
  /** 超时毫秒数。 */
  readonly ms: number;
  /** 到点动作（此时条目已移出，回调内不必也不应再查表）。 */
  readonly onTimeout: (handlers: PendingHandlers<T>) => void;
}
