// 工具审批弹窗：SSE 推送 approval.request 时在 App 层置位，本组件负责展示与响应。
//
// a11y（D1）：role="dialog" + aria-modal + aria-labelledby/describedby；打开时把焦点交给
// 「拒绝」——审批是安全闸门，默认落点应是权限最小的那个选项，而不是最顺手的那个。
// Tab 在框内圈定循环；**刻意不做「Esc = 拒绝」**：静默拒绝会让等待中的模型收到一个用户
// 从未做出的决定（与 D4 的对话框同理，决策不可静默产生）。
//
// 函数组件范式：三个按钮 ref 与「已聚焦过的请求」标记用 useRef；
// 原 componentDidMount + componentDidUpdate 的 focusDefault 合为一个依赖 approval 的 effect。
// 纯展示组件：决策通过回调上抛，自身不保存业务状态。

import { React } from '../deps.js';
import { jsonView } from '../format.js';
import type { ApprovalRequest } from '../../types/models.js';

/** ApprovalModal 组件的入参。 */
export interface ApprovalModalProps {
  /** 待审批请求；为 null 时渲染为隐藏遮罩。 */
  approval: ApprovalRequest | null;
  /** 用户决策：允许 / 拒绝 + 是否始终允许。 */
  onRespond: (decision: 'allow' | 'deny', always: boolean) => void;
  /** 点击「更改权限」：让外层打开权限档位选择器（App 置位设置页 / 派发聚焦）。 */
  onChangePermission?: () => void;
}

/** 隐藏态：React 的 style 必须是对象映射，不能是 CSS 字符串。 */
const HIDDEN: Record<string, string> = { display: 'none' };

/**
 * 工具审批弹窗：展示工具名 / 目标 / 参数，并给出「始终允许 / 拒绝 / 允许」三档决策。
 * @param props 组件入参
 * @returns 审批弹窗节点（无待审批时为隐藏遮罩）
 */
export function ApprovalModal(props: ApprovalModalProps): ReactElement {
  const { approval, onRespond, onChangePermission } = props;
  /** 「始终允许」按钮引用（Tab 圈定用）。 */
  const alwaysRef = React.useRef<HTMLButtonElement | null>(null);
  /** 「拒绝」按钮引用（Tab 圈定 / 默认焦点）。 */
  const denyRef = React.useRef<HTMLButtonElement | null>(null);
  /** 「允许」按钮引用（Tab 圈定用）。 */
  const allowRef = React.useRef<HTMLButtonElement | null>(null);
  /** 已为其设置过焦点默认值的请求（避免同一请求重复抢焦点）。 */
  const focusedForRef = React.useRef<ApprovalRequest | null>(null);

  // 新请求到来 / 挂载时设置默认焦点（零 DOM 环境下 ref 为空则静默跳过）。
  React.useEffect(() => {
    if (!approval) {
      focusedForRef.current = null;
      return;
    }
    if (approval === focusedForRef.current) return;
    focusedForRef.current = approval;
    denyRef.current?.focus();
  }, [approval]);

  /**
   * Tab 在三个按钮间循环（简单焦点圈定）。
   * @param e 键盘事件
   */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const list = [alwaysRef.current, denyRef.current, allowRef.current];
    const size = list.length;
    const active = list.findIndex((el) => el !== null && el === document.activeElement);
    const from = active < 0 ? (e.shiftKey ? 0 : -1) : active;
    list[(from + (e.shiftKey ? -1 : 1) + size) % size]?.focus();
  };

  if (!approval) return <div className="overlay" style={HIDDEN}></div>;
  const args = approval.args != null ? jsonView(approval.args) : '';
  return (
    <div className="overlay show" onKeyDown={onKeyDown}>
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
              alwaysRef.current = el;
            }}
            onClick={() => onRespond('allow', true)}
          >
            始终允许
          </button>
          <button
            className="deny"
            ref={(el: HTMLButtonElement | null) => {
              denyRef.current = el;
            }}
            onClick={() => onRespond('deny', false)}
          >
            拒绝
          </button>
          <button
            className="allow"
            ref={(el: HTMLButtonElement | null) => {
              allowRef.current = el;
            }}
            onClick={() => onRespond('allow', false)}
          >
            允许
          </button>
        </div>
        {onChangePermission ? (
          <div className="approval-change-perm">
            <button className="link" onClick={onChangePermission}>
              更改权限
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
