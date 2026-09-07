// 轻提示：由 App 的 toast 状态驱动渲染，替代 vanilla 版直接操作 DOM 的 toast。

import { html } from '../deps.js';
import type { ToastState } from '../shared.js';

export function Toast(props: { toast: ToastState }): ReactElement {
  const { toast } = props;
  const cls = 'toast' + (toast.visible ? ' show' : '') + ' ' + toast.kind;
  return html`<div className=${cls}>${toast.message}</div>`;
}
