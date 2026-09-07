// 工具审批弹窗：SSE 推送 approval.request 时在 App 层置位，本组件负责展示与响应。

import { html } from '../deps.js';
import { jsonView } from '../format.js';
import type { ApprovalRequest } from '../../types/models.js';

export interface ApprovalModalProps {
  approval: ApprovalRequest | null;
  onRespond: (decision: 'allow' | 'deny', always: boolean) => void;
}

/** 隐藏态：React 的 style 必须是对象映射，不能是 CSS 字符串。 */
const HIDDEN: Record<string, string> = { display: 'none' };

export function ApprovalModal(props: ApprovalModalProps): ReactElement {
  const { approval, onRespond } = props;
  if (!approval) return html`<div className="overlay" style=${HIDDEN}></div>`;
  const args = approval.args != null ? jsonView(approval.args) : '';
  return html`<div className="overlay show">
    <div className="modal">
      <h3>🔐 工具审批请求</h3>
      <div className="meta">工具：${approval.toolName || '?'}</div>
      <div className="meta">目标：${approval.target || '—'}</div>
      <pre>${args}</pre>
      <div className="actions">
        <button className="always" onClick=${() => onRespond('allow', true)}>始终允许</button>
        <button className="deny" onClick=${() => onRespond('deny', false)}>拒绝</button>
        <button className="allow" onClick=${() => onRespond('allow', false)}>允许</button>
      </div>
    </div>
  </div>`;
}
