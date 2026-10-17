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

/** 单个 hook 槽位（state / ref 共用存储位）。 */
// 槽位结构：{ kind: 'state' | 'ref' | 'effect', value }

/** createElement 桩：产出纯数据 vnode {type, props, children}，不触 DOM。 */
/**
 * 创建一次「假 React」运行时。
 * @returns 运行时对象（含 React/ReactDOM 桩、install、render、set、get）
 */
export function createRuntime() {
  /** 按序号排布的 hook 槽位（跨渲染保持）。 */
  const slots = [];
  /** 当前渲染的 hook 游标。 */
  let cursor = 0;
  /** 本次渲染的预设值：{ [hookIndex]: value }。 */
  let seeds = null;
  /** 本运行时的应用上下文桩（useApp 的返回值）。 */
  const appContext = {
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

  /** class 组件桩基类：仅承载 props / state，供过渡期 class 组件 `new` 使用。 */
  class FakeComponent {
    /**
     * @param props 组件属性
     */
    constructor(props) {
      this.props = props ?? {};
      this.state = {};
    }
    /**
     * 桩版 setState：对象浅合并（挂载测试不驱动真实生命周期）。
     * @param patch 状态补丁（对象或基于前态的函数）
     * @returns 无
     */
    setState(patch) {
      this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
    }
  }

  const React = {
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
     * @param value 初值（本桩忽略）
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
      const setter = (next) => {
        const prev = slots[i] ? slots[i].value : undefined;
        const value = typeof next === 'function' ? next(prev) : next;
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
      const dispatch = (action) => {
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
      return slots[i].value;
    },
    /**
     * 桩版 useEffect：占位槽位、不执行（零 DOM 环境无真实提交阶段）。
     * @returns 无
     */
    useEffect() {
      cursor++;
    },
    /**
     * 桩版 useLayoutEffect：同 useEffect。
     * @returns 无
     */
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
    /**
     * 桩版 useContext：恒返回本运行时的应用上下文（模拟「已在 Provider 内」）。
     * @returns 应用上下文桩
     */
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
      return getSnapshot();
    },
  };

  const ReactDOM = { createRoot: () => ({ render() {} }) };

  /** 简易 localStorage 桩（组件内如需持久化偏好时不炸）。 */
  const store = new Map();

  const runtime = {
    React,
    ReactDOM,
    appContext,
    /**
     * 安装到 globalThis.window（deps.js 在模块顶层读 window）。
     * @returns 无
     */
    install() {
      globalThis.window = {
        React,
        ReactDOM,
        addEventListener() {},
        removeEventListener() {},
        setTimeout: () => 0,
        clearTimeout() {},
        setInterval: () => 0,
        clearInterval() {},
        localStorage: {
          /**
           * @param k 键
           * @returns 值或 null
           */
          getItem: (k) => (store.has(k) ? store.get(k) : null),
          /**
           * @param k 键
           * @param v 值
           * @returns 无
           */
          setItem: (k, v) => store.set(k, String(v)),
          /**
           * @param k 键
           * @returns 无
           */
          removeItem: (k) => store.delete(k),
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
      return vnode;
    },
    /**
     * 直接改写某 hook 槽位的值。
     * @param index hook 序号
     * @param value 新值
     * @returns 无
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
    /**
     * 清空全部 hook 槽位（测试之间隔离）。
     * @returns 无
     */
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
// 现在 UI 直接 `import * as React from 'react'`，测试侧由 `vitest.config.ts` 的
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

/** Fragment 的稳定符号（stub 与"react 模块导出"共用同一个，避免身份比较假红）。 */
const STUB_FRAGMENT = Symbol('Fragment');

/** StrictMode 的稳定符号（同上；桩里只作直通包裹层，不做双跑）。 */
const STUB_STRICTMODE = Symbol('StrictMode');

/** 当前生效的 runtime（由 `createRuntime()` 设置）。 */
let currentRuntime = null;

/**
 * 取当前 runtime 的桩 React；**没有人安装时惰性自建一个**。
 *
 * 为什么允许惰性自建：并非所有判据都显式调用 `createRuntime()`。
 * 例如 `format.test.mjs` 只渲染纯函数产出的 vnode（`esc` / `badge` / `jsonView`…），
 * 从不触 hook，历史上它自己手搓了一个 `fakeReact` 挂在 `window.React` 上。
 * `deps.ts` 删除后那条通路没了 —— 若这里直接抛错，17 条本来与 React 无关的判据会一起红。
 * 惰性自建让"只想调一下纯函数"的判据零成本继续工作，而需要控制 hook 槽位的判据
 * 仍然自己调 `createRuntime()` 覆盖它。
 * @returns 桩 React 对象
 */
function currentReact() {
  if (currentRuntime === null) currentRuntime = createRuntime();
  return currentRuntime.React;
}

/** 桩版 createElement（转发到当前 runtime）。 */
export function createElement(...args) {
  return currentReact().createElement(...args);
}

/** Fragment（稳定符号）。 */
export const Fragment = STUB_FRAGMENT;

/** StrictMode（稳定符号，直通渲染）。 */
export const StrictMode = STUB_STRICTMODE;

/** 桩版 useState（转发）。 */
export function useState(...args) {
  return currentReact().useState(...args);
}

/** 桩版 useReducer（转发）。 */
export function useReducer(...args) {
  return currentReact().useReducer(...args);
}

/** 桩版 useRef（转发）。 */
export function useRef(...args) {
  return currentReact().useRef(...args);
}

/** 桩版 useEffect（转发）。 */
export function useEffect(...args) {
  return currentReact().useEffect(...args);
}

/** 桩版 useLayoutEffect（转发）。 */
export function useLayoutEffect(...args) {
  return currentReact().useLayoutEffect(...args);
}

/** 桩版 useMemo（转发）。 */
export function useMemo(...args) {
  return currentReact().useMemo(...args);
}

/** 桩版 useCallback（转发）。 */
export function useCallback(...args) {
  return currentReact().useCallback(...args);
}

/** 桩版 useContext（转发）。 */
export function useContext(...args) {
  return currentReact().useContext(...args);
}

/** 桩版 useSyncExternalStore（转发）。 */
export function useSyncExternalStore(...args) {
  return currentReact().useSyncExternalStore(...args);
}

/** 桩版 createContext（转发）。 */
export function createContext(...args) {
  return currentReact().createContext(...args);
}

/** 桩版 memo（转发）。 */
export function memo(...args) {
  return currentReact().memo(...args);
}

/** 桩版 createRef（转发）。 */
export function createRef(...args) {
  return currentReact().createRef(...args);
}

/** 桩版 Component 基类（转发）。 */
export function Component(...args) {
  return currentReact().Component(...args);
}
