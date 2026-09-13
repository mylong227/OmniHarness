// 应用内对话框宿主：把 DialogService 的待决请求渲染成模态框，替代 window.confirm / window.prompt。
//
// a11y（D1）：role="dialog" + aria-modal + aria-labelledby/describedby；
// 打开时把焦点交给最合理的控件（危险操作默认落「取消」），Tab 圈定在框内，Esc 取消。
// 纯展示 + 键盘壳：决策结果一律经 DialogService 结算，组件自身不保存业务状态。

import { React } from '../deps.js';
import { AppComponent } from '../base/AppComponent.js';
import type { DialogRequest, DialogState } from '../../core/DialogService.js';

export interface DialogHostProps {
  /** 对话框渲染状态（由 App 状态驱动）。 */
  dialog: DialogState;
}

interface DialogHostState {
  /** prompt 输入框的当前文本。 */
  text: string;
}

/** 隐藏态：React 的 style 必须是对象映射，不能是 CSS 字符串。 */
const HIDDEN: Record<string, string> = { display: 'none' };

/** 对话框宿主组件。 */
export class DialogHost extends AppComponent<DialogHostProps, DialogHostState> {
  /** 确认按钮引用（焦点管理用）。 */
  private confirmRef: HTMLButtonElement | null = null;
  /** 取消按钮引用（焦点管理用）。 */
  private cancelRef: HTMLButtonElement | null = null;
  /** prompt 输入框引用（焦点管理用）。 */
  private inputRef: HTMLInputElement | null = null;
  /** 上一次处理的请求引用：用于识别「新请求到来」以重置输入与焦点。 */
  private seen: DialogRequest | null = null;

  /**
   * @param props 组件属性
   */
  public constructor(props: DialogHostProps) {
    super(props);
    this.state = { text: '' };
  }

  /** 首次挂载即有待决请求时同步输入值与焦点。 @returns 无 */
  public override componentDidMount(): void {
    this.syncRequest();
  }

  /** 请求变化时重置输入值并把焦点交给默认控件。 @returns 无 */
  public override componentDidUpdate(): void {
    this.syncRequest();
  }

  /** 可聚焦元素（按 DOM 顺序）：prompt 有输入框，confirm 只有两个按钮。 */
  private focusables(): (HTMLElement | null)[] {
    const { request } = this.props.dialog;
    if (!request) return [];
    return request.kind === 'prompt'
      ? [this.inputRef, this.cancelRef, this.confirmRef]
      : [this.cancelRef, this.confirmRef];
  }

  /** 请求变化 → 同步输入初值；随后把焦点交给默认控件。 @returns 无 */
  private syncRequest(): void {
    const { request } = this.props.dialog;
    if (!request) {
      this.seen = null;
      return;
    }
    if (request === this.seen) return;
    this.seen = request;
    this.setState({ text: request.initial });
    this.focusDefault(request);
  }

  /**
   * 默认焦点：prompt 落输入框（全选便于覆盖）；危险确认落「取消」（安全默认），
   * 其余落「确认」。元素尚未挂载（零 DOM 测试环境）时静默跳过。
   * @param request 当前请求
   * @returns 无
   */
  private focusDefault(request: DialogRequest): void {
    if (request.kind === 'prompt') {
      this.inputRef?.focus();
      this.inputRef?.select();
      return;
    }
    if (request.danger) this.cancelRef?.focus();
    else this.confirmRef?.focus();
  }

  /** 在框内循环移动焦点（简单 Tab 圈定）。 @returns 无 */
  private cycleFocus(backward: boolean): void {
    const list = this.focusables();
    const size = list.length;
    if (size === 0) return;
    const active = list.findIndex((el) => el !== null && el === document.activeElement);
    // 焦点不在框内时：向后从第一个起步，向前从最后一个起步。
    const from = active < 0 ? (backward ? 0 : -1) : active;
    const next = (from + (backward ? -1 : 1) + size) % size;
    list[next]?.focus();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.dialog.cancel();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      this.cycleFocus(e.shiftKey);
    }
  };

  private readonly onInput = (e: Event): void => {
    this.setState({ text: (e.target as HTMLInputElement | null)?.value ?? '' });
  };

  private readonly onInputKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.dialog.submit(this.state.text);
    }
  };

  private readonly onConfirm = (): void => {
    this.dialog.submit(this.state.text);
  };

  private readonly onCancel = (): void => {
    this.dialog.cancel();
  };

  /** 渲染。 @returns 对话框节点（无请求时为隐藏遮罩） */
  public override render(): ReactElement {
    const { request } = this.props.dialog;
    if (!request) return <div className="overlay" style={HIDDEN}></div>;
    const titleId = 'dlg-title';
    const bodyId = 'dlg-body';
    return (
      <div className="overlay show dlg-overlay" onKeyDown={this.onKeyDown}>
        <div
          className="modal dlg"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
        >
          <h3 id={titleId}>{request.title}</h3>
          <div className="dlg-msg" id={bodyId}>
            {request.message}
          </div>
          {request.kind === 'prompt' ? (
            <input
              className="dlg-input"
              ref={(el: HTMLInputElement | null) => {
                this.inputRef = el;
              }}
              value={this.state.text}
              placeholder={request.placeholder}
              aria-label={request.title}
              onChange={this.onInput}
              onKeyDown={this.onInputKeyDown}
            />
          ) : null}
          <div className="actions">
            <button
              className="dlg-cancel"
              ref={(el: HTMLButtonElement | null) => {
                this.cancelRef = el;
              }}
              onClick={this.onCancel}
            >
              {request.cancelLabel}
            </button>
            <button
              className={'dlg-confirm' + (request.danger ? ' danger' : '')}
              ref={(el: HTMLButtonElement | null) => {
                this.confirmRef = el;
              }}
              onClick={this.onConfirm}
            >
              {request.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
