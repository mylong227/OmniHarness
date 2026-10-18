// 函数组件测试用的最小 Hooks 运行时（无第三方依赖、零 DOM）。
//
// 背景：组件转为函数组件后不再能 `new X(props).render()`——函数组件是纯函数，
// 状态由 Hooks 持有。本运行时提供三件事，让「零 DOM 桩」测试继续可用：
//   1. 按调用序号为每个 hook 槽位分配存储，跨多次渲染保持（与 React 语义一致）；
//   2. 允许测试按槽位号预设值，替代旧测试直接写 class 实例的 `comp.state = {...}`；
//   3. 记录 setter 的调用结果（供断言「交互后状态真的变了」）。
//
// 同时保留一个 class 基类桩（Component）用于迁移过渡期：尚未迁移的 class 组件
// 仍可被 `new` 并渲染；全部迁移完成后该分支自然消失。
//
// ## 类型口径（2026-10-17 测试栈统一，.mjs → .ts 纳入 strict）
//
// 桩的职责是**承接 src 组件的任意合法用法**（props 形状、hook 返回值都由被测组件决定），
// 因此在「桩与被测代码的边界」上用 `any`（并集中到 `/* eslint-disable */` 不需要——
// 本文件只在边界参数上用，内部存储一律 `unknown`）；槽位、vnode、运行时本身都有完整类型。
// 过度收紧（如 `useState<T>` 泛型）会让 26 个判据各自为 `any` 断言绕路，得不偿失。

/** createElement 桩产出的纯数据 vnode。 */
export interface StubVnode {
  /** 元素类型（组件函数 / 字符串标签 / Fragment·StrictMode 符号）。 */
  type: unknown;
  /** 属性包（桩不校验形状）。 */
  props: Record<string, unknown>;
  /** 子节点（createElement 的剩余参数）。 */
  children: unknown[];
}

/** 单个 hook 槽位（state / ref 共用存储位）。 */
interface StubSlot {
  kind: 'state' | 'ref';
  value: unknown;
}

/** 渲染前按 hook 序号预设的值表（{ [hookIndex]: value }）。 */
type StubSeeds = Record<number, unknown> | null;

/** 本运行时的应用上下文桩（useContext 的返回值）。 */
interface StubAppContext {
  api: {
    getConfig: () => Promise<Record<string, unknown>>;
    updateConfig: (patch?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    listSessions: () => Promise<never[]>;
    rpc: (method?: string, params?: unknown) => Promise<Record<string, unknown>>;
  };
  toast: (message?: string) => void;
  dialog: { confirm: () => Promise<boolean>; prompt: () => Promise<null> };
  refreshModelCatalog: () => void;
}

/** class 组件桩基类（迁移过渡期；全部组件函数化后该分支消失）。 */
class FakeComponent {
  public props: Record<string, unknown>;
  public state: Record<string, unknown>;

  /** @param props 组件属性 */
  public constructor(props?: Record<string, unknown> | null) {
    this.props = props ?? {};
    this.state = {};
  }

  /**
   * 桩版 setState：对象浅合并（挂载测试不驱动真实生命周期）。
   * @param patch 状态补丁（对象或基于前态的函数）
   */
  public setState(patch: Record<string, unknown> | ((prev: Record<string, unknown>) => Record<string, unknown>)): void {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
  }
}

/** Fragment 的稳定符号（stub 与"react 模块导出"共用同一个，避免身份比较假红）。 */
const STUB_FRAGMENT = Symbol('Fragment');

/** StrictMode 的稳定符号（同上；桩里只作直通包裹层，不做双跑）。 */
const STUB_STRICTMODE = Symbol('StrictMode');

/** 桩运行时的形状（createRuntime 的返回值；判据经它读写 hook 槽位）。 */
// 边界类型按文件头（第 12–17 行）的口径放宽为 any：桩必须承接被测组件任意合法 props / hook 返回值，
// 收紧只会逼 26 个判据各自绕路。此处集中 disable（仅覆盖 StubRuntime 与 stubReactShape 两块边界定义）。
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface StubRuntime {
  React: stubReactShape;
  ReactDOM: { createRoot: () => { render: () => void } };
  appContext: StubAppContext;
  /** 安装到 globalThis.window（含 localStorage / timer / 事件监听桩）。 */
  install: () => void;
  /** 渲染一次函数组件（props 形状由被测组件决定，故边界为 any）。 */
  render: (Component: (props: any) => any, props?: unknown, seed?: StubSeeds) => StubVnode;
  /** 直接改写某 hook 槽位的值。 */
  set: (index: number, value: unknown) => void;
  /** 读取某 hook 槽位的当前值（不存在时 undefined）。 */
  get: (index: number) => unknown;
  /** 清空全部 hook 槽位（测试之间隔离）。 */
  reset: () => void;
}

// 桩 React 的类型只在 StubRuntime 里被引用；用类型别名承接（真实对象在 createRuntime 内构造）。
// 声明成 any 形状会丢掉判据里的成员提示；这里用「结构化 any 方法」折衷：
// 每个 hook 的调用形态在 createRuntime 里有真实实现，对外只保证可调用。
type stubReactShape = {
  Component: typeof FakeComponent;
  createElement: (type: unknown, props?: Record<string, unknown>, ...children: unknown[]) => StubVnode;
  Fragment: symbol;
  StrictMode: symbol;
  createContext: () => { Provider: () => void; Consumer: () => void };
  memo: (fn: any) => any;
  createRef: () => { current: null };
  useState: (init?: any) => [any, (next: any) => void];
  useReducer: (reducer: (state: any, action: any) => any, init?: any) => [any, (action: any) => void];
  useRef: (init?: any) => { current: unknown };
  useEffect: () => void;
  useLayoutEffect: () => void;
  useMemo: (fn: () => any) => any;
  useCallback: (fn: any) => any;
  useContext: () => StubAppContext;
  useSyncExternalStore: (subscribe?: unknown, getSnapshot?: () => any) => any;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * 创建一次「假 React」运行时。
 * @returns 运行时对象（含 React/ReactDOM 桩、install、render、set、get）
 */
export function createRuntime(): StubRuntime {
  /** 按序号排布的 hook 槽位（跨渲染保持）。 */
  const slots: StubSlot[] = [];
  /** 当前渲染的 hook 游标。 */
  let cursor = 0;
  /** 本次渲染的预设值：{ [hookIndex]: value }。 */
  let seeds: StubSeeds = null;
  /** 本运行时的应用上下文桩（useContext 的返回值）。 */
  const appContext: StubAppContext = {
    api: {
      getConfig: async () => ({}),
      updateConfig: async () => ({}),
      listSessions: async () => [],
      rpc: async () => ({}),
    },
    toast: () => {},
    dialog: { confirm: async () => true, prompt: async () => null },
    refreshModelCatalog: () => {},
  };

  const React: stubReactShape = {
    Component: FakeComponent,
    /**
     * 桩版 createElement：收集为纯数据 vnode。
     * @param type 元素类型
     * @param props 属性
     * @param children 子节点
     * @returns vnode
     */
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    Fragment: STUB_FRAGMENT,
    /**
     * 桩版 StrictMode：**直通**（渲染时当作一个普通包裹层）。
     *
     * 为什么必须有：`mountApp` 现在把树包进 `React.StrictMode`。桩若没有这个成员，
     * `createElement(undefined, ...)` 会造出 type=undefined 的节点，判据里看不到 App 的内容
     *（表现是"挂载了但什么都没渲染"，很难第一时间联想到 StrictMode）。
     * 真实 StrictMode 的"双跑"语义在零 DOM 桩里没有意义，故此处只保证可渲染。
     */
    StrictMode: STUB_STRICTMODE,
    /**
     * 桩版 createContext：只要 Provider/Consumer 形状存在即可。
     * @returns 上下文桩
     */
    createContext() {
      return { Provider() {}, Consumer() {} };
    },
    /**
     * 桩版 memo：直接返回原函数（本测试不比较重渲染）。
     * @param fn 组件函数
     * @returns 原组件函数
     */
    memo(fn) {
      return fn;
    },
    /**
     * 桩版 createRef。
     * @returns ref 对象
     */
    createRef() {
      return { current: null };
    },
    /**
     * 桩版 useState：按序号在槽位中保持值。
     * @param init 初始值或惰性初始化函数
     * @returns [当前值, setter]
     */
    useState(init) {
      const i = cursor++;
      if (seeds && Object.prototype.hasOwnProperty.call(seeds, i)) {
        slots[i] = { kind: 'state', value: seeds[i] };
      } else if (!slots[i]) {
        slots[i] = { kind: 'state', value: typeof init === 'function' ? init() : init };
      }
      const setter = (next: unknown) => {
        const prev = slots[i] ? slots[i].value : undefined;
        const value = typeof next === 'function' ? (next as (p: unknown) => unknown)(prev) : next;
        slots[i] = { kind: 'state', value };
      };
      return [slots[i].value, setter];
    },
    /**
     * 桩版 useReducer：以 reducer 驱动槽位值。
     * @param reducer 归约函数
     * @param init 初始状态
     * @returns [当前状态, dispatch]
     */
    useReducer(reducer, init) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { kind: 'state', value: init };
      const dispatch = (action: unknown) => {
        slots[i] = { kind: 'state', value: reducer(slots[i].value, action) };
      };
      return [slots[i].value, dispatch];
    },
    /**
     * 桩版 useRef：槽位保持同一对象引用。
     * @param init 初值
     * @returns ref 对象
     */
    useRef(init) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { kind: 'ref', value: { current: init } };
      // ref 槽位的 value 恒为 { current } 形状（见上方的赋值），从 unknown 收窄回来。
      return slots[i].value as { current: unknown };
    },
    /** 桩版 useEffect：占位槽位、不执行（零 DOM 环境无真实提交阶段）。 */
    useEffect() {
      cursor++;
    },
    /** 桩版 useLayoutEffect：同 useEffect。 */
    useLayoutEffect() {
      cursor++;
    },
    /**
     * 桩版 useMemo：立即求值（本测试不缓存）。
     * @param fn 计算函数
     * @returns 计算结果
     */
    useMemo(fn) {
      cursor++;
      return fn();
    },
    /**
     * 桩版 useCallback：直接返回原函数。
     * @param fn 回调
     * @returns 原回调
     */
    useCallback(fn) {
      cursor++;
      return fn;
    },
    /** 桩版 useContext：恒返回本运行时的应用上下文（模拟「已在 Provider 内」）。 */
    useContext() {
      return appContext;
    },
    /**
     * 桩版 useSyncExternalStore：**直接取快照**（零 DOM 下没有订阅时机）。
     *
     * 为什么必须补：`SettingsModal` 用它订阅 `SettingsModel`（1 处调用）。缺了它，
     * 只要某个判据渲染到设置模态就会 `undefined is not a function`。
     * @param _subscribe 订阅函数（本桩不调用）
     * @param getSnapshot 取快照
     * @returns 快照值
     */
    useSyncExternalStore(_subscribe, getSnapshot) {
      cursor++;
      // 运行时语义保持不变：快照函数缺失时与原实现一样直接抛错（非空断言不改变控制流）。
      return getSnapshot!();
    },
  };

  const ReactDOM = { createRoot: () => ({ render() {} }) };

  /** 简易 localStorage 桩（组件内如需持久化偏好时不炸）。 */
  const store = new Map<string, string>();

  const runtime: StubRuntime = {
    React,
    ReactDOM,
    appContext,
    /**
     * 安装到 globalThis.window（deps.js 在模块顶层读 window）。
     */
    install() {
      (globalThis as Record<string, unknown>).window = {
        React,
        ReactDOM,
        addEventListener() {},
        removeEventListener() {},
        setTimeout: () => 0,
        clearTimeout() {},
        setInterval: () => 0,
        clearInterval() {},
        localStorage: {
          /** @param k 键 @returns 值或 null */
          getItem: (k: string) => (store.has(k) ? store.get(k) : null),
          /** @param k 键 @param v 值 */
          setItem: (k: string, v: string) => store.set(k, String(v)),
          /** @param k 键 */
          removeItem: (k: string) => store.delete(k),
        },
      };
    },
    /**
     * 渲染一次函数组件。
     * @param Component 组件函数
     * @param props 组件属性
     * @param seed 按 hook 序号预设的值（{ [index]: value }），缺省沿用槽位现值
     * @returns vnode 树
     */
    render(Component, props, seed) {
      cursor = 0;
      seeds = seed ?? null;
      const vnode = Component(props);
      seeds = null;
      return vnode as StubVnode;
    },
    /**
     * 直接改写某 hook 槽位的值。
     * @param index hook 序号
     * @param value 新值
     */
    set(index, value) {
      slots[index] = { kind: 'state', value };
    },
    /**
     * 读取某 hook 槽位的当前值。
     * @param index hook 序号
     * @returns 槽位值（不存在时为 undefined）
     */
    get(index) {
      return slots[index] ? slots[index].value : undefined;
    },
    /** 清空全部 hook 槽位（测试之间隔离）。 */
    reset() {
      slots.length = 0;
      cursor = 0;
      seeds = null;
    },
  };
  // 设为"当前 runtime"：react 模块替身的所有具名导出都转发到它（见文件末尾）。
  currentRuntime = runtime;
  return runtime;
}

// ============================================================================
// 作为 **react 模块替身** 导出（2026-10-17，`deps.ts` 移除后）
// ----------------------------------------------------------------------------
// 迁移前 UI 代码从 `src/ui/deps.ts` 取 React，而 `deps.ts` 读 `window.React` ——
// 那是零打包器 + UMD 时代的收口点，也是本仓最后一处「非标准 React 项目」的形态。
// 现在 UI 直接 `import * as React from 'react'`，测试侧由 `vitest.workspace.ts` 的
// `resolve.alias` 把 `react` 指到本文件，于是：
//
//   `import * as React from 'react'`  →  拿到下面这些具名导出  →  转发到当前 runtime 的桩
//
// 为什么用"模块级 current runtime"而不是每个判据文件写 `vi.mock`：`vi.mock` 的工厂
// 会被提升到文件顶部、拿不到测试里的闭包变量，26 个文件都要各自绕一遍；
// 而 `createRuntime()` 本来就在每个判据里调用，让它顺手把自己设为"当前 runtime"最省事。
//
// ⚠️ `install()` 必须保留：它除了注入 React，还负责 `window` 上的 localStorage /
// timer / 事件监听桩 —— 组件里真实用到了它们。
// ============================================================================

/** 当前生效的 runtime（由 `createRuntime()` 设置）。 */
let currentRuntime: StubRuntime | null = null;

/**
 * 取当前 runtime 的桩 React；**没有人安装时惰性自建一个**。
 *
 * 为什么允许惰性自建：并非所有判据都显式调用 `createRuntime()`。
 * 例如 `format.test` 只渲染纯函数产出的 vnode（`esc` / `badge` / `jsonView`…），
 * 从不触 hook，历史上它自己手搓了一个 `fakeReact` 挂在 `window.React` 上。
 * `deps.ts` 删除后那条通路没了 —— 若这里直接抛错，17 条本来与 React 无关的判据会一起红。
 * 惰性自建让"只想调一下纯函数"的判据零成本继续工作，而需要控制 hook 槽位的判据
 * 仍然自己调 `createRuntime()` 覆盖它。
 * @returns 桩 React 对象
 */
function currentReact(): stubReactShape {
  if (currentRuntime === null) currentRuntime = createRuntime();
  return currentRuntime.React;
}

/** 桩版 createElement（转发到当前 runtime）。 */
export function createElement(...args: Parameters<stubReactShape['createElement']>): StubVnode {
  return currentReact().createElement(...args);
}

/** Fragment（稳定符号）。 */
export const Fragment = STUB_FRAGMENT;

/** StrictMode（稳定符号，直通渲染）。 */
export const StrictMode = STUB_STRICTMODE;

/** 桩版 useState（转发）。 */
export function useState(...args: Parameters<stubReactShape['useState']>): ReturnType<stubReactShape['useState']> {
  return currentReact().useState(...args);
}

/** 桩版 useReducer（转发）。 */
export function useReducer(
  ...args: Parameters<stubReactShape['useReducer']>
): ReturnType<stubReactShape['useReducer']> {
  return currentReact().useReducer(...args);
}

/** 桩版 useRef（转发）。 */
export function useRef(...args: Parameters<stubReactShape['useRef']>): ReturnType<stubReactShape['useRef']> {
  return currentReact().useRef(...args);
}

/** 桩版 useEffect（转发）。 */
export function useEffect(): void {
  currentReact().useEffect();
}

/** 桩版 useLayoutEffect（转发）。 */
export function useLayoutEffect(): void {
  currentReact().useLayoutEffect();
}

/** 桩版 useMemo（转发）。 */
export function useMemo(...args: Parameters<stubReactShape['useMemo']>): ReturnType<stubReactShape['useMemo']> {
  return currentReact().useMemo(...args);
}

/** 桩版 useCallback（转发）。 */
export function useCallback(
  ...args: Parameters<stubReactShape['useCallback']>
): ReturnType<stubReactShape['useCallback']> {
  return currentReact().useCallback(...args);
}

/** 桩版 useContext（转发）。 */
export function useContext(): StubAppContext {
  return currentReact().useContext();
}

/** 桩版 useSyncExternalStore（转发）。 */
export function useSyncExternalStore(
  ...args: Parameters<stubReactShape['useSyncExternalStore']>
): ReturnType<stubReactShape['useSyncExternalStore']> {
  return currentReact().useSyncExternalStore(...args);
}

/** 桩版 createContext（转发）。 */
export function createContext(
  ...args: Parameters<stubReactShape['createContext']>
): ReturnType<stubReactShape['createContext']> {
  return currentReact().createContext(...args);
}

/** 桩版 memo（转发）。 */
export function memo(...args: Parameters<stubReactShape['memo']>): ReturnType<stubReactShape['memo']> {
  return currentReact().memo(...args);
}

/** 桩版 createRef（转发）。 */
export function createRef(
  ...args: Parameters<stubReactShape['createRef']>
): ReturnType<stubReactShape['createRef']> {
  return currentReact().createRef(...args);
}

/** 桩版 Component 基类（转发）。 */
export function Component(...args: unknown[]): FakeComponent {
  const Ctor = currentReact().Component;
  return new Ctor(...(args as ConstructorParameters<typeof FakeComponent>));
}
