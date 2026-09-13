// 面向对象的服务层：应用内「决策对话框」的发布者，替代 window.confirm / window.prompt。
//
// 为什么必须是有返回值的对话框，而不是 Toast：
//   confirm 是**决策闸门**（返回 boolean，决定「丢弃改动」这类不可逆动作是否执行），
//   prompt 是**输入闸门**（返回 string|null）。二者一旦退化成「只提示、不阻塞」的 Toast，
//   就会出现「点了没反应」或「静默执行不可逆操作」——这是行为回归，不是体验优化。
//   因此本服务保留 Promise 语义：调用方 `await` 到用户真实选择后才继续。
//
// 解耦方式与 ToastService 一致：服务只做「请求 → 订阅槽」，由 App 绑定到 React 状态后
// 交给 DialogHost 渲染，组件无需把对话框塞进自己的子树。

/** 对话框种类。 */
export type DialogKind = 'confirm' | 'prompt';

/** 打开对话框的可选文案 / 外观。 */
export interface DialogOptions {
  /** 标题（缺省按种类给默认值）。 */
  readonly title?: string;
  /** 确认按钮文案（缺省「确定」）。 */
  readonly confirmLabel?: string;
  /** 取消按钮文案（缺省「取消」）。 */
  readonly cancelLabel?: string;
  /** prompt 输入框占位符。 */
  readonly placeholder?: string;
  /** 是否危险操作（确认按钮用警示色 + 默认焦点落到「取消」）。 */
  readonly danger?: boolean;
}

/** 一次待决的对话框请求（宿主组件据此渲染）。 */
export interface DialogRequest {
  readonly kind: DialogKind;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly placeholder: string;
  readonly danger: boolean;
  /** prompt 的初始值（confirm 恒为空串）。 */
  readonly initial: string;
}

/** 对话框渲染状态（无待决请求时 request 为 null）。 */
export interface DialogState {
  readonly request: DialogRequest | null;
}

/** 内部结算值：confirm 用 boolean，prompt 用 string，取消用 null。 */
type DialogResult = boolean | string | null;

type DialogSink = (state: DialogState) => void;

/** 确认 / 取消按钮的缺省文案。 */
export const DEFAULT_CONFIRM_LABEL = '确定';
export const DEFAULT_CANCEL_LABEL = '取消';

/** 应用内对话框服务：发起 Promise、由宿主渲染、用户选择后结算。 */
export class DialogService {
  /** 绑定到 React 状态的订阅槽（App 挂载时注入）。 */
  private sink: DialogSink | null = null;
  /** 当前待决请求（null = 无对话框）。 */
  private request: DialogRequest | null = null;
  /** 当前待决的结算函数（与 request 同生命周期）。 */
  private settleFn: ((value: DialogResult) => void) | null = null;

  /**
   * 由 App 在挂载时绑定到 React 状态，使对话框真正渲染出来。
   * @param sink 接收渲染状态的回调
   * @returns 无
   */
  public bind(sink: DialogSink): void {
    this.sink = sink;
  }

  /** 当前渲染状态（宿主组件只读消费）。 */
  public get state(): DialogState {
    return { request: this.request };
  }

  /** 是否有待决对话框。 */
  public get pending(): boolean {
    return this.request !== null;
  }

  /**
   * 弹出确认对话框（替代 window.confirm）。
   * @param message 正文（说明动作与后果）
   * @param options 文案 / 危险态
   * @returns 用户确认返回 true；取消返回 false
   */
  public confirm(message: string, options?: DialogOptions): Promise<boolean> {
    return this.open('confirm', message, '', options).then((value) => value === true);
  }

  /**
   * 弹出文本输入对话框（替代 window.prompt）。
   * @param message 正文
   * @param initial 输入框初始值
   * @param options 文案 / 占位符
   * @returns 用户提交返回输入串（可为空串）；取消返回 null
   */
  public prompt(message: string, initial = '', options?: DialogOptions): Promise<string | null> {
    return this.open('prompt', message, initial, options).then((value) =>
      typeof value === 'string' ? value : null,
    );
  }

  /**
   * 宿主组件在用户点击「确认」时调用。
   * @param value prompt 的输入值（confirm 忽略此参数）
   * @returns 无
   */
  public submit(value: string): void {
    const request = this.request;
    if (!request) return;
    this.settle(request.kind === 'confirm' ? true : value);
  }

  /** 宿主组件在用户点击「取消」/ 按 Esc / 点遮罩时调用。 @returns 无 */
  public cancel(): void {
    if (!this.request) return;
    this.settle(null);
  }

  /**
   * 打开对话框并把请求推给宿主。
   * @param kind 对话框种类
   * @param message 正文
   * @param initial prompt 的输入初始值（confirm 传空串）
   * @param options 文案 / 危险态
   * @returns 用户选择后的结算值
   */
  private open(
    kind: DialogKind,
    message: string,
    initial: string,
    options?: DialogOptions,
  ): Promise<DialogResult> {
    if (!this.sink) {
      // fail-closed：没有宿主就渲染不出对话框。此时「静默取消」等于让不可逆动作无声消失，
      // 「静默确认」则更危险。宁可显式抛错，把装配疏漏暴露在开发期。
      throw new Error('DialogService 尚未绑定宿主，无法显示对话框');
    }
    // 前一个未结算的请求按「取消」收口，避免悬挂的 Promise 永远不 resolve。
    if (this.request) this.settle(null);
    return new Promise<DialogResult>((resolve) => {
      this.request = {
        kind,
        title: options?.title ?? (kind === 'confirm' ? '请确认' : '请输入'),
        message,
        confirmLabel: options?.confirmLabel ?? DEFAULT_CONFIRM_LABEL,
        cancelLabel: options?.cancelLabel ?? DEFAULT_CANCEL_LABEL,
        placeholder: options?.placeholder ?? '',
        danger: options?.danger === true,
        initial: kind === 'prompt' ? initial : '',
      };
      this.settleFn = resolve;
      this.emit();
    });
  }

  /**
   * 结算当前请求：清空状态、通知宿主、兑现 Promise。
   * @param value 结算值
   * @returns 无
   */
  private settle(value: DialogResult): void {
    const resolve = this.settleFn;
    this.request = null;
    this.settleFn = null;
    this.emit();
    resolve?.(value);
  }

  /** 把当前状态推给宿主（未绑定则静默）。 @returns 无 */
  private emit(): void {
    this.sink?.(this.state);
  }
}
