// 轻提示：由 App 的 toast 状态驱动渲染，替代 vanilla 版直接操作 DOM 的 toast。
// 纯展示组件，无内部状态（class 组件只负责渲染）。

import { React } from '../deps.js';
import { AppComponent } from '../base/AppComponent.js';
import type { ToastState } from '../shared.js';

export interface ToastProps {
  toast: ToastState;
}

/** 轻提示组件。 */
export class Toast extends AppComponent<ToastProps> {
  override render(): ReactElement {
    const { toast } = this.props;
    const cls = 'toast' + (toast.visible ? ' show' : '') + ' ' + toast.kind;
    // role=status + aria-live=polite：提示是「异步告知」，不应打断辅助技术的当前朗读。
    return (
      <div className={cls} role="status" aria-live="polite" aria-atomic="true">
        {toast.message}
      </div>
    );
  }
}
