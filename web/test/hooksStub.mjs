// 函数组件测试用的最小 Hooks 运行时（零依赖、零 DOM）。
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
    Fragment: Symbol('Fragment'),
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
  };

  const ReactDOM = { createRoot: () => ({ render() {} }) };

  /** 简易 localStorage 桩（组件内如需持久化偏好时不炸）。 */
  const store = new Map();

  return {
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
}
