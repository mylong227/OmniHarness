// 轻提示：由 App 的 toast 状态驱动渲染，替代 vanilla 版直接操作 DOM 的 toast。
// 纯展示组件（函数组件范式）：无内部状态、无副作用、无服务依赖。

import { React } from '../deps.js';
import type { ToastState } from '../shared.js';

/** Toast 组件的入参。 */
export interface ToastProps {
  /** 当前轻提示状态（可见性 / 语义色 / 文案）。 */
  toast: ToastState;
}

/**
 * 轻提示：把 toast 状态渲染为一条无障碍提示。
 * @param props 组件入参
 * @returns 提示节点
 */
export function Toast(props: ToastProps): ReactElement {
  const { toast } = props;
  const cls = 'toast' + (toast.visible ? ' show' : '') + ' ' + toast.kind;
  // role=status + aria-live=polite：提示是「异步告知」，不应打断辅助技术的当前朗读。
  return (
    <div className={cls} role="status" aria-live="polite" aria-atomic="true">
      {toast.message}
    </div>
  );
}
