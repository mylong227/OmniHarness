// 应用内对话框宿主：把 DialogService 的待决请求渲染成模态框，替代 window.confirm / window.prompt。
//
// a11y（D1）：role="dialog" + aria-modal + aria-labelledby/describedby；
// 打开时把焦点交给最合理的控件（危险操作默认落「取消」），Tab 圈定在框内，Esc 取消。
// 纯展示 + 键盘壳：决策结果一律经 DialogService 结算，组件自身不保存业务状态。
//
// 函数组件范式：输入文本一个 useState；三个控件引用 + seen 请求镜像各一个 useRef；
// 「请求变化 → 重置输入值并把焦点交给默认控件」原由 componentDidMount/Update 两处调用同一方法，
// 现由依赖 request 的单个 effect 承接（挂载即有待决请求的情形也一并覆盖）。

import { React } from '../deps.js';
import { useApp } from '../context.js';
import type { DialogRequest, DialogState } from '../../core/DialogService.js';

/** DialogHost 组件的入参。 */
export interface DialogHostProps {
  /** 对话框渲染状态（由 App 状态驱动）。 */
  dialog: DialogState;
}

/** 隐藏态：React 的 style 必须是对象映射，不能是 CSS 字符串。 */
const HIDDEN: Record<string, string> = { display: 'none' };

/**
 * 对话框宿主：渲染待决的确认 / 输入请求，并把焦点与键盘收束在框内。
 * @param props 组件入参
 * @returns 对话框节点（无请求时为隐藏遮罩）
 */
export function DialogHost(props: DialogHostProps): ReactElement {
  const { dialog } = props;
  const { dialog: dialogSvc } = useApp();
  const request = dialog.request;
  /** prompt 输入框的当前文本。 */
  const [text, setText] = React.useState<string>('');
  /** 确认按钮引用（焦点管理用）。 */
  const confirmRef = React.useRef<HTMLButtonElement | null>(null);
  /** 取消按钮引用（焦点管理用）。 */
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);
  /** prompt 输入框引用（焦点管理用）。 */
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  /** 上一次处理的请求引用：用于识别「新请求到来」以重置输入与焦点。 */
  const seen = React.useRef<DialogRequest | null>(null);

  // 请求变化 → 同步输入初值，随后把焦点交给默认控件（元素尚未挂载时静默跳过）。
  React.useEffect(() => {
    if (!request) {
      seen.current = null;
      return;
    }
    if (request === seen.current) return;
    seen.current = request;
    setText(request.initial);
    if (request.kind === 'prompt') {
      // prompt 落输入框（全选便于覆盖）。
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    // 危险确认落「取消」（安全默认），其余落「确认」。
    if (request.danger) cancelRef.current?.focus();
    else confirmRef.current?.focus();
  }, [request]);

  if (!request) return <div className="overlay" style={HIDDEN}></div>;

  /** 可聚焦元素（按 DOM 顺序）：prompt 有输入框，confirm 只有两个按钮。 */
  const focusables = (): (HTMLElement | null)[] =>
    request.kind === 'prompt'
      ? [inputRef.current, cancelRef.current, confirmRef.current]
      : [cancelRef.current, confirmRef.current];

  /**
   * 在框内循环移动焦点（简单 Tab 圈定）。
   * @param backward 是否反向（Shift+Tab）
   * @returns 无
   */
  const cycleFocus = (backward: boolean): void => {
    const list = focusables();
    const size = list.length;
    if (size === 0) return;
    const active = list.findIndex((el) => el !== null && el === document.activeElement);
    // 焦点不在框内时：向后从第一个起步，向前从最后一个起步。
    const from = active < 0 ? (backward ? 0 : -1) : active;
    const next = (from + (backward ? -1 : 1) + size) % size;
    list[next]?.focus();
  };

  /**
   * 框级键盘：Esc 取消、Tab 圈定焦点。
   * @param e 键盘事件
   * @returns 无
   */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      dialogSvc.cancel();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      cycleFocus(e.shiftKey);
    }
  };

  /**
   * 输入框变更 → 同步文本。
   * @param e 输入事件
   * @returns 无
   */
  const onInput = (e: Event): void => {
    setText((e.target as HTMLInputElement | null)?.value ?? '');
  };

  /**
   * 输入框回车 → 提交当前文本。
   * @param e 键盘事件
   * @returns 无
   */
  const onInputKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dialogSvc.submit(text);
    }
  };

  const titleId = 'dlg-title';
  const bodyId = 'dlg-body';
  return (
    <div className="overlay show dlg-overlay" onKeyDown={onKeyDown}>
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
            ref={inputRef}
            value={text}
            placeholder={request.placeholder}
            aria-label={request.title}
            onChange={onInput}
            onKeyDown={onInputKeyDown}
          />
        ) : null}
        <div className="actions">
          <button className="dlg-cancel" ref={cancelRef} onClick={() => dialogSvc.cancel()}>
            {request.cancelLabel}
          </button>
          <button
            className={'dlg-confirm' + (request.danger ? ' danger' : '')}
            ref={confirmRef}
            onClick={() => dialogSvc.submit(text)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
