// 环境类型声明：本工程 UI 以 UMD 全局方式本地内置 React / ReactDOM / htm（见 web/vendor/），
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

interface ReactApi {
  createElement(type: any, props?: Record<string, unknown> | null, ...children: unknown[]): ReactElement;
  Fragment: unknown;
  createContext<T>(defaultValue: T): ReactContext<T>;
  useState<S>(initial: S | (() => S)): [S, Dispatch<S>];
  useEffect(effect: EffectCallback, deps?: ReadonlyArray<unknown>): void;
  useRef<T>(initial: T): { current: T };
  useReducer<S, A>(reducer: Reducer<S, A>, initial: S): [S, Dispatch<A>];
  useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: ReadonlyArray<unknown>): T;
  useMemo<T>(fn: () => T, deps: ReadonlyArray<unknown>): T;
  useContext<T>(ctx: ReactContext<T>): T;
}

interface ReactDOMApi {
  createRoot(container: Element): { render(node: ReactNode): void };
}

type HtmFn = ((strings: TemplateStringsArray, ...values: unknown[]) => ReactElement) & {
  bind(factory: unknown): HtmFn;
};

declare const React: ReactApi;
declare const ReactDOM: ReactDOMApi;
declare const htm: HtmFn;
