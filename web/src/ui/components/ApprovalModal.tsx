// 工具审批弹窗：SSE 推送 approval.request 时在 App 层置位，本组件负责展示与响应。
// 纯展示组件：决策通过回调上抛，无内部状态。

import { React } from '../deps.js';
import { jsonView } from '../format.js';
import type { ApprovalRequest } from '../../types/models.js';

export interface ApprovalModalProps {
  approval: ApprovalRequest | null;
  onRespond: (decision: 'allow' | 'deny', always: boolean) => void;
  /** 点击「更改权限」：让外层打开权限档位选择器（App 置位设置页 / 派发聚焦）。 */
  onChangePermission?: () => void;
}

/** 隐藏态：React 的 style 必须是对象映射，不能是 CSS 字符串。 */
const HIDDEN: Record<string, string> = { display: 'none' };

/** 工具审批弹窗组件。 */
export class ApprovalModal extends React.Component<ApprovalModalProps> {
  private onAllowAlways(): void {
    this.props.onRespond('allow', true);
  }

  private onDeny(): void {
    this.props.onRespond('deny', false);
  }

  private onAllowOnce(): void {
    this.props.onRespond('allow', false);
  }

  override render(): ReactElement {
    const { approval } = this.props;
    if (!approval) return <div className="overlay" style={HIDDEN}></div>;
    const args = approval.args != null ? jsonView(approval.args) : '';
    return (
      <div className="overlay show">
        <div className="modal">
          <h3>🔐 工具审批请求</h3>
          <div className="meta">工具：{approval.toolName || '?'}</div>
          <div className="meta">目标：{approval.target || '—'}</div>
          <pre>{args}</pre>
          <div className="actions">
            <button className="always" onClick={this.onAllowAlways.bind(this)}>
              始终允许
            </button>
            <button className="deny" onClick={this.onDeny.bind(this)}>
              拒绝
            </button>
            <button className="allow" onClick={this.onAllowOnce.bind(this)}>
              允许
            </button>
          </div>
          {this.props.onChangePermission ? (
            <div className="approval-change-perm">
              <button className="link" onClick={this.props.onChangePermission}>
                更改权限
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }
}
