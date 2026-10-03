// 渲染错误边界：把「整页空白」变成**看得见、可诊断、可恢复**的错误。
//
// ## 为什么必须有它（2026-09-27 用户两次报障「按 Enter 后整页空白」）
//
// React 在**渲染期**抛错且树上**没有错误边界**时，会直接卸载整棵树 —— 画面变成全黑空白页，
// 用户看不到任何线索，我也拿不到抛出点（真浏览器复现该 URL、复现短回合、复现带工具的回合都正常，
// 只有用户的长回合会崩）。函数组件没有 `componentDidCatch` 等价物，故这里必须是 class 组件
// （`react-shim.d.ts` 已为它保留最小 class 形态声明）。
//
// 有边界之后：
//   ① 页面不再空白 —— 错误消息 + 「重试」/「重新加载」按钮就在屏幕上；
//   ② 现场写进 sessionStorage（`omni-last-render-error`，含组件栈），用户一句话就能把真因带回来；
//   ③ 点「重试」可原地恢复渲染（清掉边界态重挂子树），不必丢掉当前会话。
import { React } from '../deps.js';

/** 边界状态。 */
interface RenderErrorBoundaryState {
  /** 捕获到的渲染错误（null = 正常）。 */
  error: Error | null;
  /** React 给出的组件栈（定位「哪个组件抛的」——渲染错误里最有价值的一段）。 */
  componentStack: string;
  /** 详情是否已复制（按钮反馈）。 */
  copied: boolean;
}

/** 现场留存键（sessionStorage：不跨标签页，避免旧错误干扰新会话）。 */
const STORE_KEY = 'omni-last-render-error';

/** 把现场写进 sessionStorage（隐私模式等失败一律忽略：诊断信息不该反过来弄崩页面）。 */
function remember(error: Error, componentStack: string): void {
  try {
    sessionStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        at: new Date().toISOString(),
        message: error.message,
        stack: (error.stack ?? '').slice(0, 1200),
        componentStack: componentStack.slice(0, 2000),
      }),
    );
  } catch {
    /* 忽略 */
  }
}

/** 渲染错误边界（class 组件：捕获渲染期异常并降级为可读面板）。 */
export class RenderErrorBoundary extends React.Component<
  // `children` 用官方 `ReactNode`（不再是 `unknown`）：`render` 必须返回 ReactNode，
  // 而 `unknown` 无法赋给它——旧手写垫片没有这层约束，于是"什么都塞得进去"。
  { children?: ReactNode },
  RenderErrorBoundaryState
> {
  /**
   * @param props 子节点
   */
  public constructor(props: { children?: ReactNode }) {
    super(props);
    this.state = { error: null, componentStack: '', copied: false };
  }

  /**
   * 渲染期抛错时把错误放进 state（React 据此重渲染为降级面板）。
   * @param error 抛出的错误
   * @returns 新的边界状态（保留既有 componentStack，随后由 componentDidCatch 补齐）
   */
  public static getDerivedStateFromError(error: Error): Partial<RenderErrorBoundaryState> {
    return { error };
  }

  /**
   * 记录现场（控制台 + sessionStorage），并把组件栈放进 state 以便**直接显示在面板上**。
   *
   * 为什么要显示出来：`Illegal invocation` 这类消息本身不含位置信息，只有组件栈能指出抛在哪一层；
   * 让用户去翻控制台是把定位成本推给用户（2026-09-27 实测：截图上只有一行消息，仍无法定位）。
   * @param error 抛出的错误
   * @param info React 提供的组件栈
   * @returns 无返回值
   */
  public componentDidCatch(error: Error, info: { componentStack?: string }): void {
    const componentStack = info?.componentStack ?? '';
    remember(error, componentStack);
    this.setState({ componentStack });
    // 边界本身不该吞掉错误：控制台照样打印，便于开发时定位。
    console.error('[RenderErrorBoundary]', error, componentStack);
  }

  /** 清掉边界态，原地重挂子树。 @returns 无返回值 */
  private reset = (): void => {
    this.setState({ error: null, componentStack: '', copied: false });
  };

  /** 整页重载（兜底：子树状态已不可信时）。 @returns 无返回值 */
  private reload = (): void => {
    location.reload();
  };

  /**
   * 把「错误消息 + 组件栈 + 时间」复制到剪贴板（用户一句话即可把现场交给维护者）。
   * @returns 无返回值
   */
  private copyDetail = (): void => {
    const error = this.state.error;
    const text = [
      `时间：${new Date().toISOString()}`,
      `消息：${error?.message ?? ''}`,
      `栈：${(error?.stack ?? '').split('\n').slice(0, 8).join('\n')}`,
      `组件栈：${this.state.componentStack}`,
      `URL：${location.href}`,
    ].join('\n');
    try {
      void navigator.clipboard.writeText(text).then(
        () => this.setState({ copied: true }),
        () => undefined,
      );
    } catch {
      /* 剪贴板不可用：面板上的组件栈仍可手抄 */
    }
  };

  /**
   * 正常时渲染子树；捕获到错误时渲染可读降级面板（含组件栈与复制入口）。
   *
   * 返回类型必须是 `ReactNode`（不再是 `unknown`）：官方 `Component.render` 如此声明，
   * 而 `unknown` 会让这个类**不能**作为 `createElement` 的组件类型（App 的最外层边界就是这么用的）。
   * 旧的手写垫片没有这层约束，于是"返回什么都能过"。
   * @returns React 节点
   */
  public render(): ReactNode {
    const error = this.state.error;
    if (error === null) {
      return this.props.children;
    }
    const where = this.state.componentStack
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .slice(0, 4)
      .join(' ← ');
    return React.createElement(
      'div',
      { className: 'crash-panel', role: 'alert' },
      React.createElement('div', { className: 'crash-title' }, '界面渲染出错'),
      React.createElement('div', { className: 'crash-msg' }, error.message || String(error)),
      where === ''
        ? null
        : React.createElement('div', { className: 'crash-where' }, '位置：' + where),
      React.createElement(
        'div',
        { className: 'crash-hint' },
        '这是界面自身的渲染异常（不是你的操作问题）。现场已记录，可按「重新加载」继续使用；若反复出现，请点「复制详情」把内容发我。',
      ),
      React.createElement(
        'div',
        { className: 'crash-actions' },
        React.createElement(
          'button',
          { type: 'button', className: 'crash-retry', onClick: this.reset },
          '重试',
        ),
        React.createElement(
          'button',
          { type: 'button', className: 'crash-reload', onClick: this.reload },
          '重新加载',
        ),
        React.createElement(
          'button',
          { type: 'button', className: 'crash-copy', onClick: this.copyDetail },
          this.state.copied ? '已复制' : '复制详情',
        ),
      ),
    );
  }
}
