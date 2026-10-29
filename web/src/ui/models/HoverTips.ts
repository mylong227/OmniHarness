// 全站悬浮提示的 DOM 层（无 React）：悬停时**接管原生 `title` 气泡**。
//
// ## 为什么接管 title
// 原生气泡的形状、字号、最大宽度全由浏览器/系统决定（Windows 下是一块方角灰板，
// 一句稍长的说明就拉成一条极宽的横线），CSS 完全够不着。要「收窄 + 圆角 + 扁平」，
// 只能自己画：悬停期间把 `title` 摘到 `data-tip`（原生便不再出现），离开时原样放回。
//
// ## 为什么接在 document 上而不是给每个组件包一层
// 全站 120+ 处 `title`（会话行、工具卡、路径、按钮…）都会冒原生气泡。逐个改组件既改不动
// 也保不住（新加一处就漏一处）。这里用**事件委托 + title 属性**做单一入口：组件照旧写
// `title`（无障碍语义不动），展示层统一收口。
//
// ## 四个容易出错的细节
// 1) 延迟期间**不摘** title：只在真正要显示时才摘，避免"悬停 100ms 就丢掉提示"。
// 2) 同一条提示内部移动（图标→文字）不重来：否则每移过一个子节点就闪一下。
// 3) React 重渲染可能把 `title` 写回来（例如权限档位切换）⇒ 显示期间用 MutationObserver
//    把新值再挪进 `data-tip` 并同步气泡文字，否则原生与自定义两套气泡会同屏。
// 4) 弹层打开时不冒泡：菜单/选择器已经占着屏幕，再弹一条提示是噪音（`isBlocked`）。

/** 一条待显示的提示。 */
export interface HoverTipRequest {
  /** 提示文字（`title` 原值）。 */
  readonly text: string;
  /** 触发元素（定位锚点）。 */
  readonly el: Element;
}

/** 装配参数。 */
export interface HoverTipsOptions {
  /** 延迟结束、确定要显示时回调。 */
  readonly onShow: (tip: HoverTipRequest) => void;
  /** 收起时回调（离开 / 点击 / 滚动 / 卸载）。 */
  readonly onHide: () => void;
  /** 显示闸门：返回 true 时不冒泡（如已有弹层打开）。 */
  readonly isBlocked?: () => boolean;
  /** 悬停多久后显示（毫秒）；默认 {@link DEFAULT_DELAY_MS}。 */
  readonly delayMs?: number;
}

/** `title` 属性名（原生气泡的来源）。 */
const TITLE_ATTR = 'title';
/** 摘下来的 `title` 暂存位置（原生不会读它，因此不会冒泡）。 */
const STASH_ATTR = 'data-tip';
/** 默认延迟：比原生（约 400–500ms）快，又足以滤掉"鼠标路过"。 */
const DEFAULT_DELAY_MS = 180;

/**
 * 悬浮提示控制器：只管"什么时候显示哪条 title"，不碰样式与位置。
 */
export class HoverTips {
  private readonly doc: Document;
  private readonly opts: HoverTipsOptions;
  /** 当前已显示的触发元素（`title` 已摘）。 */
  private active: Element | null = null;
  /** 正在等待延迟的触发元素（`title` 仍挂着）。 */
  private pending: Element | null = null;
  private timer = 0;
  private observer: MutationObserver | null = null;
  private readonly bindings: Array<{
    readonly target: EventTarget;
    readonly type: string;
    readonly handler: EventListener;
    readonly capture: boolean;
  }> = [];

  /**
   * @param doc 宿主文档（测试可注入，生产为全局 `document`）
   * @param opts 回调与闸门
   */
  public constructor(doc: Document, opts: HoverTipsOptions) {
    this.doc = doc;
    this.opts = opts;
  }

  /**
   * 挂上委托监听；返回卸载器（对称摘监听、恢复 `title`、收起气泡）。
   * @returns 卸载函数
   */
  public attach(): () => void {
    this.on(this.doc, 'mouseover', this.handleOver, true);
    this.on(this.doc, 'mouseout', this.handleOut, true);
    this.on(this.doc, 'mousedown', this.handleDismiss, true);
    this.on(this.doc, 'keydown', this.handleKey, true);
    this.on(this.doc, 'scroll', this.handleDismiss, true);
    this.on(this.doc, 'mousemove', this.handleMove, true);
    const win = this.doc.defaultView;
    if (win !== null) {
      this.on(win, 'resize', this.handleDismiss);
      this.on(win, 'blur', this.handleDismiss);
    }
    return () => {
      for (const binding of this.bindings.splice(0)) {
        binding.target.removeEventListener(binding.type, binding.handler, binding.capture);
      }
      this.hide();
    };
  }

  /**
   * 登记一条监听（统一记下 capture，卸载时才能精确摘掉）。
   * @param target 事件目标
   * @param type 事件名
   * @param handler 处理器
   * @param capture 是否捕获阶段
   * @returns 无
   */
  private on(target: EventTarget, type: string, handler: EventListener, capture = false): void {
    target.addEventListener(type, handler, capture);
    this.bindings.push({ target, type, handler, capture });
  }

  /**
   * 指针进入某元素：算出它的 `title` 祖先，决定是"继续当前提示"还是"换一条"。
   * @param event 原生 mouseover
   * @returns 无
   */
  private readonly handleOver = (event: Event): void => {
    if (!(event instanceof MouseEvent)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    // 同一条提示内部（图标 → 文字）移动：保持不动；若子节点自己也带 title，则换它。
    if (this.active !== null && this.active.contains(target)) {
      const inner = target.closest(`[${TITLE_ATTR}]`);
      if (inner === null || inner === this.active || !this.active.contains(inner)) return;
      this.hide();
      this.schedule(inner);
      return;
    }
    this.hide();
    if (this.opts.isBlocked?.() === true) return;
    const el = target.closest(`[${TITLE_ATTR}]`);
    if (el !== null) this.schedule(el);
  };

  /**
   * 指针离开：只有真正离开当前/待显示的触发元素才收起（子节点之间移动不收起）。
   * @param event 原生 mouseout
   * @returns 无
   */
  private readonly handleOut = (event: Event): void => {
    if (!(event instanceof MouseEvent)) return;
    const to = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (to !== null) {
      if (this.active !== null && this.active.contains(to)) return;
      if (this.pending !== null && this.pending.contains(to)) return;
    }
    this.hide();
  };

  /**
   * 点击（含右键/中键）收起：点击之后用户要操作的是元素，不是读提示。
   * @returns 无
   */
  private readonly handleDismiss = (): void => {
    this.hide();
  };

  /**
   * Esc 收起（不阻断冒泡：各处的 Esc 仍有自己的职责）。
   * @param event 原生 keydown
   * @returns 无
   */
  private readonly handleKey = (event: Event): void => {
    if (event instanceof KeyboardEvent && event.key === 'Escape') this.hide();
  };

  /**
   * 指针仍在移动时顺手检查锚点是否已被卸载（React 重渲染常换节点）。
   * @returns 无
   */
  private readonly handleMove = (): void => {
    if (this.active !== null && !this.active.isConnected) this.hide();
  };

  /**
   * 排一条延迟显示；若期间离开，`handleOut` 会清掉它。
   * @param el 触发元素（此时 `title` 仍挂着）
   * @returns 无
   */
  private schedule(el: Element): void {
    this.pending = el;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.reveal(el);
    }, this.opts.delayMs ?? DEFAULT_DELAY_MS);
  }

  /**
   * 延迟到点：真正摘 `title`、挂观察器、通知外层画气泡。
   * @param el 触发元素
   * @returns 无
   */
  private reveal(el: Element): void {
    this.pending = null;
    if (!el.isConnected || this.opts.isBlocked?.() === true) return;
    const text = this.stash(el);
    if (text === '') return;
    this.active = el;
    this.watch(el);
    this.opts.onShow({ text, el });
  }

  /**
   * 收起当前提示并恢复 `title`。
   * @returns 无
   */
  private hide(): void {
    if (this.timer !== 0) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
    this.pending = null;
    this.observer?.disconnect();
    this.observer = null;
    const el = this.active;
    this.active = null;
    if (el === null) return;
    this.restore(el);
    this.opts.onHide();
  }

  /**
   * 把 `title` 挪进 `data-tip`（原生不再冒泡），返回原值。
   * @param el 触发元素
   * @returns 原值；空串表示没有可显示的提示
   */
  private stash(el: Element): string {
    const raw = el.getAttribute(TITLE_ATTR) ?? '';
    if (raw.trim() === '') return '';
    el.setAttribute(STASH_ATTR, raw);
    el.removeAttribute(TITLE_ATTR);
    return raw;
  }

  /**
   * 把 `data-tip` 放回 `title`（元素若已被卸载则什么也不做——原生随之消失）。
   * @param el 触发元素
   * @returns 无
   */
  private restore(el: Element | null): void {
    if (el === null) return;
    const stashed = el.getAttribute(STASH_ATTR);
    if (stashed === null) return;
    el.removeAttribute(STASH_ATTR);
    el.setAttribute(TITLE_ATTR, stashed);
  }

  /**
   * 显示期间盯住触发元素的 `title`：React 写回来的新值要再摘一次，并同步气泡文字。
   * @param el 触发元素
   * @returns 无
   */
  private watch(el: Element): void {
    if (typeof MutationObserver !== 'function') return;
    this.observer = new MutationObserver(() => {
      if (!el.isConnected) {
        this.hide();
        return;
      }
      const raw = el.getAttribute(TITLE_ATTR) ?? '';
      if (raw.trim() === '') return;
      el.setAttribute(STASH_ATTR, raw);
      el.removeAttribute(TITLE_ATTR);
      this.opts.onShow({ text: raw, el });
    });
    this.observer.observe(this.doc.documentElement, {
      attributes: true,
      attributeFilter: [TITLE_ATTR],
      subtree: true,
    });
  }
}
