// 工具审批弹窗：SSE 推送 approval.request 时在 App 层置位，本组件负责展示与响应。
//
// a11y（D1）：role="dialog" + aria-modal + aria-labelledby/describedby；打开时把焦点交给
// 「拒绝」——审批是安全闸门，默认落点应是权限最小的那个选项，而不是最顺手的那个。
// Tab 在框内圈定循环；**刻意不做「Esc = 拒绝」**：静默拒绝会让等待中的模型收到一个用户
// 从未做出的决定（与 D4 的对话框同理，决策不可静默产生）。
//
// 纯展示组件：决策通过回调上抛，自身不保存业务状态。

import { React } from '../deps.js';
import { AppComponent } from '../base/AppComponent.js';
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
export class ApprovalModal extends AppComponent<ApprovalModalProps> {
  /** 「始终允许」按钮引用（Tab 圈定用）。 */
  private alwaysRef: HTMLButtonElement | null = null;
  /** 「拒绝」按钮引用（Tab 圈定 / 默认焦点）。 */
  private denyRef: HTMLButtonElement | null = null;
  /** 「允许」按钮引用（Tab 圈定用）。 */
  private allowRef: HTMLButtonElement | null = null;
  /** 已为其设置过焦点默认值的请求（避免每次重渲染都抢焦点）。 */
  private focusedFor: ApprovalRequest | null = null;

  /** 挂载时若已有待审批请求则设置默认焦点。 @returns 无 */
  public override componentDidMount(): void {
    this.focusDefault();
  }

  /** 新请求到来时设置默认焦点（同一请求不重复抢焦点）。 @returns 无 */
  public override componentDidUpdate(): void {
    this.focusDefault();
  }

  /** 默认焦点：落到「拒绝」（安全默认）。零 DOM 环境下 ref 为空则静默跳过。 @returns 无 */
  private focusDefault(): void {
    const { approval } = this.props;
    if (!approval) {
      this.focusedFor = null;
      return;
    }
    if (approval === this.focusedFor) return;
    this.focusedFor = approval;
    this.denyRef?.focus();
  }

  /** Tab 在三个按钮间循环（简单焦点圈定）。 @returns 无 */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const list = [this.alwaysRef, this.denyRef, this.allowRef];
    const size = list.length;
    const active = list.findIndex((el) => el !== null && el === document.activeElement);
    const from = active < 0 ? (e.shiftKey ? 0 : -1) : active;
    list[(from + (e.shiftKey ? -1 : 1) + size) % size]?.focus();
  };

  private readonly onAllowAlways = (): void => {
    this.props.onRespond('allow', true);
  };

  private readonly onDeny = (): void => {
    this.props.onRespond('deny', false);
  };

  private readonly onAllowOnce = (): void => {
    this.props.onRespond('allow', false);
  };

  /** 渲染。 @returns 审批弹窗节点（无待审批时为隐藏遮罩） */
  public override render(): ReactElement {
    const { approval } = this.props;
    if (!approval) return <div className="overlay" style={HIDDEN}></div>;
    const args = approval.args != null ? jsonView(approval.args) : '';
    return (
      <div className="overlay show" onKeyDown={this.onKeyDown}>
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ap-title"
          aria-describedby="ap-desc"
        >
          <h3 id="ap-title">🔐 工具审批请求</h3>
          <div className="meta">工具：{approval.toolName || '?'}</div>
          <div className="meta">目标：{approval.target || '—'}</div>
          <pre id="ap-desc">{args}</pre>
          <div className="actions">
            <button
              className="always"
              ref={(el: HTMLButtonElement | null) => {
                this.alwaysRef = el;
              }}
              onClick={this.onAllowAlways}
            >
              始终允许
            </button>
            <button
              className="deny"
              ref={(el: HTMLButtonElement | null) => {
                this.denyRef = el;
              }}
              onClick={this.onDeny}
            >
              拒绝
            </button>
            <button
              className="allow"
              ref={(el: HTMLButtonElement | null) => {
                this.allowRef = el;
              }}
              onClick={this.onAllowOnce}
            >
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
