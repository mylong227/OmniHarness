// JSX 自动运行时的**测试垫片**：把 `react/jsx-runtime` 的 `jsx/jsxs/Fragment` 转到
// `hooksStub` 的桩 `createElement` 上，从而在"自动运行时"下继续产出**纯数据 vnode**。
//
// ## 为什么需要它
//
// 2026-10-17 把 `web/tsconfig.json` 的 `jsx` 从 `"react"`（classic）改成 `"react-jsx"`
//（自动运行时，标准 Vite React 配置）。生产侧两种都行，但**测试侧有隐含依赖**：
//
//   `web/test/hooksStub.mjs` 用一套假 React 跑 25 个**零 DOM** 组件判据——
//   它的 `createElement` 返回 `{ type, props, children }` 纯数据，判据靠直接遍历这棵树
//   断言 className / 文案 / 结构。classic 运行时会把 JSX 编译成 `React.createElement(...)`，
//   正好落到桩上；换成自动运行时后 JSX 变成 `jsx(...)`（来自 `react/jsx-runtime`），
//   也就是**真 React 的** vnode 工厂 ⇒ 判据拿到真实元素对象、遍历不到任何东西
//   （实测：10 条判据一起报 `0 !== 1`，看起来像"组件不再渲染"）。
//
// 两条路：① 退回 classic（放弃标准）；② 给自动运行时补一层垫片（本文件）。
// 选 ②：生产保持标准，测试机制不变，改动集中在这 20 行。
//
// ## 两个必须处理的语义差异
//
//   1. **children 位置**：classic 传 `createElement(type, props, ...children)`，
//      children 是第 3 个参数；自动运行时把 children 塞进 `props.children`。
//   2. **Fragment 身份**：桩的 `Fragment` 是**每个 runtime 现造的 Symbol**
//      （`createRuntime()` 里 `Symbol('Fragment')`），所以垫片不能导出自己的固定符号——
//      必须把哨兵换成"当前 runtime 的 Fragment"，否则判据里 `type === rt.React.Fragment`
//      会假红。
//
// 只在 vitest 里生效（`vitest.config.ts` 的 `resolve.alias`），不影响生产构建。

/** 垫片自己的 Fragment 哨兵（在 el() 里替换成当前 runtime 的 Fragment）。 */
const SENTINEL = Symbol('jsx-runtime-stub Fragment');

/** 对外的 Fragment（转成 JSX `<>` 时调用方拿到的是哨兵）。 */
export const Fragment = SENTINEL;

/**
 * 把自动运行时的调用翻译成桩的 `createElement`。
 * @param type 元素类型（可能是哨兵 Fragment）
 * @param props 属性（可能含 children）
 * @returns 纯数据 vnode
 */
function el(type, props) {
  const runtime = globalThis.window?.React;
  if (runtime === undefined) {
    // 没装桩就说明这个文件的用例不该走这里；直接失败比静默返回 undefined 好定位。
    throw new Error('jsxRuntimeStub：未安装 hooksStub（缺 window.React），无法产出 vnode');
  }
  const { children, ...rest } = props ?? {};
  const actualType = type === SENTINEL ? runtime.Fragment : type;
  // ⚠️ 必须**展开**数组 children，不能整包成一个参数。
  //
  // 自动运行时的 `jsxs(type, { children: [a, b] })` 里 children 是一个数组；若写成
  // `createElement(type, props, [a, b])`，桩拿到的 `vnode.children` 就是 `[[a, b]]`
  // —— 嵌套一层。多数判据的 kids() 会 `.flat(Infinity)` 所以看不出问题，但
  // `mount.test.mjs` 的 `walk()`/`texts()` 逐层遍历 `children` 且**不处理数组节点**，
  // 于是文案一个都取不到（实测：4 条判据假红，报 `/默认/`、`/正在调用 shell/` 匹配失败）。
  // 展开后与 classic 的 `createElement(type, props, ...children)` 语义完全等价。
  if (children === undefined) return runtime.createElement(actualType, rest);
  return Array.isArray(children)
    ? runtime.createElement(actualType, rest, ...children)
    : runtime.createElement(actualType, rest, children);
}

/**
 * 单子节点版（自动运行时对 1 个子节点调这个）。
 * @param type 元素类型
 * @param props 属性
 * @returns vnode
 */
export function jsx(type, props) {
  return el(type, props);
}

/**
 * 多子节点版（自动运行时对 >1 个子节点调这个，children 是数组）。
 * @param type 元素类型
 * @param props 属性
 * @returns vnode
 */
export function jsxs(type, props) {
  return el(type, props);
}

/** 开发态变体（Vitest 的 esbuild 可能用 jsxDEV）。 */
export const jsxDEV = jsx;
