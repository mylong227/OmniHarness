// 环境类型声明：本工程 UI 以 UMD 全局方式本地内置 React / ReactDOM（见 web/vendor/；
// htm 已于 2026-09-13 全量摘除，UI 一律用 React.createElement 编写），
// 不安装任何 react npm 包，构建与运行时均零网络依赖。本文件仅声明 UI 实际用到的 React API 子集，
// 使 TypeScript 在零依赖下仍能对组件进行强类型检查。

interface ReactElement {
  type: unknown;
  props: Record<string, unknown>;
  key: unknown;
}

type ReactNode =
  | ReactElement
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<ReactNode>;

interface ReactContext<T> {
  Provider: (props: { value: T; children?: ReactNode }) => ReactElement;
  Consumer: (props: { children: (value: T) => ReactNode }) => ReactElement;
}

type Dispatch<A> = (action: A | ((prevState: A) => A)) => void;
type Reducer<S, A> = (state: S, action: A) => S;
type EffectCallback = () => void | (() => void);

// ---- Hooks / 元素 / 上下文（函数组件范式）----
// 说明：本工程 UI 已全量迁移为函数组件 + Hooks（R1），故不再声明 class 组件基类
// （`React.Component` / `createRef` / `SetStateAction`）。若将来必须新增 class
// 错误边界（componentDidCatch 无 Hook 等价物），需在此重新声明最小 class 形态。

interface ReactApi {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): ReactElement;
  Fragment: unknown;
  createContext<T>(defaultValue: T): ReactContext<T>;
  useState<S>(initial: S | (() => S)): [S, Dispatch<S>];
  useEffect(effect: EffectCallback, deps?: ReadonlyArray<unknown>): void;
  useLayoutEffect(effect: EffectCallback, deps?: ReadonlyArray<unknown>): void;
  useRef<T>(initial: T): { current: T };
  useReducer<S, A>(reducer: Reducer<S, A>, initial: S): [S, Dispatch<A>];
  useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: ReadonlyArray<unknown>): T;
  useMemo<T>(fn: () => T, deps: ReadonlyArray<unknown>): T;
  useContext<T>(ctx: ReactContext<T>): T;
}

interface ReactDOMApi {
  createRoot(container: Element): { render(node: ReactNode): void };
}

declare const React: ReactApi;
declare const ReactDOM: ReactDOMApi;

// ---- JSX 类型（tsx 编译为 React.createElement 后仍需元素属性检查）----
//
// 说明：本工程零依赖（不装 @types/react），这里自建 JSX 元素类型。
// 常用属性显式声明以获得检查，其余走索引签名逃生舱，避免为每个标签维护上百个属性。

interface HtmlAttributes {
  className?: string;
  id?: string;
  style?: string | Record<string, string | number>;
  role?: string;
  title?: string;
  tabIndex?: number;
  disabled?: boolean;
  hidden?: boolean;
  key?: string | number;
  // 无障碍（本项目 a11y 基线要求）
  'aria-label'?: string;
  'aria-modal'?: string | boolean;
  'aria-selected'?: string | boolean;
  'aria-expanded'?: string | boolean;
  'aria-haspopup'?: string;
  'aria-hidden'?: string | boolean;
  'aria-live'?: string;
  'aria-atomic'?: string | boolean;
  'aria-relevant'?: string;
  'aria-current'?: string | boolean;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  // 事件
  onClick?: (e: MouseEvent) => void;
  onMouseDown?: (e: MouseEvent) => void;
  onMouseEnter?: (e: MouseEvent) => void;
  onMouseLeave?: (e: MouseEvent) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  onKeyUp?: (e: KeyboardEvent) => void;
  onInput?: (e: Event) => void;
  onChange?: (e: Event) => void;
  onFocus?: (e: FocusEvent) => void;
  onBlur?: (e: FocusEvent) => void;
  onSubmit?: (e: Event) => void;
  children?: ReactNode;
  /** 逃生舱：未显式声明的 HTML 属性（如 data-*）仍可通过。 */
  [attr: string]: unknown;
}

interface InputAttributes extends HtmlAttributes {
  type?: string;
  value?: string | number;
  placeholder?: string;
  checked?: boolean;
  readOnly?: boolean;
  rows?: number;
  accept?: string;
  multiple?: boolean;
}

interface AnchorAttributes extends HtmlAttributes {
  href?: string;
  target?: string;
  rel?: string;
  download?: string;
}

interface MediaAttributes extends HtmlAttributes {
  src?: string;
  alt?: string;
  width?: number | string;
  height?: number | string;
}

declare namespace JSX {
  interface Element extends ReactElement {}
  /**
   * 所有 JSX 元素共有的属性。与 @types/react 的 `React.Attributes` 对齐：
   * `key` 由 React 消费（不进 props），故必须在类型层显式放行，否则 `<Item key={...} />` 会报错。
   */
  interface IntrinsicAttributes {
    key?: string | number | null;
  }
  interface IntrinsicElements {
    // 具体标签细化（更强的属性检查）
    input: InputAttributes;
    textarea: InputAttributes;
    select: InputAttributes;
    a: AnchorAttributes;
    img: MediaAttributes;
    video: MediaAttributes;
    // 其余标签走通用 HTML 属性 + 逃生舱
    [tag: string]: HtmlAttributes;
  }
}
