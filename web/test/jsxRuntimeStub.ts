// JSX 自动运行时的**测试垫片**：把 `react/jsx-runtime` 的 `jsx/jsxs` 转到桩的 `createElement`。
//
// ## 为什么需要它
//
// `web/tsconfig.json` 用 `jsx: "react-jsx"`（标准 Vite React 配置）。生产侧没问题，
// 但 25 个零 DOM 组件判据依赖 `hooksStub` 的"纯数据 vnode"
// （`{ type, props, children }`）—— 那种结构只在 classic 运行时（JSX → `React.createElement`）
// 下成立。自动运行时的 `jsx()` 会造**真 React 的** element，判据遍历不到任何东西
// （实测：10 条判据一起报 `0 !== 1`，看起来像"组件不再渲染"）。
//
// 于是 `vitest.config.ts` 把 `react/jsx-runtime` 指到本文件，把 `jsx/jsxs` 也导到桩上。
//
// ## 依赖注入：从 `react` 拿，而不是 `window.React`
//
// 2026-10-17 之后 `react` 本身已被 alias 到 `hooksStub`（`deps.ts` 已删除，UI 改为
// `import * as React from 'react'`）。所以这里直接 `import { createElement, Fragment } from 'react'`
// —— 同一个桩、同一个 Fragment 符号，不需要哨兵替换，也不会出现身份不一致。
//
// ## 必须处理的语义差异
//
// **children 位置**：classic 是 `createElement(type, props, ...children)`，children 是第 3 个
// 参数；自动运行时把 children 塞进 `props.children`。若整包成一个参数，
// `vnode.children` 会变成 `[[a, b]]`（多嵌套一层）—— 多数判据的 `kids()` 有 `.flat(Infinity)`
// 所以看不出，但 `mount.test.mjs` 的 `walk()/texts()` 逐层遍历且**不处理数组节点**，
// 会一个文案都取不到（实测 4 条判据假红）。因此数组必须**展开**。
import { createElement as reactStubCreateElement, Fragment } from 'react';
import type { StubRuntime } from './hooksStub';

// tsc 侧 `react` 解析为真实 @types/react（vitest 运行时才把它 alias 到 hooksStub 桩），
// 本文件的 createElement 实际是桩实现：props 形状是 Record<string, unknown>、children 是
// unknown[]，与真实 React 的重载互不重叠，无法表达为单一 as。这条「桩↔桩」边界
// 经 unknown 双跳收窄到桩的真实签名。
const createElement = reactStubCreateElement as unknown as StubRuntime['React']['createElement'];

/**
 * 把自动运行时的调用翻译成桩的 `createElement`。
 * @param type 元素类型
 * @param props 属性（可能含 children）
 * @returns 纯数据 vnode
 */
function el(type: unknown, props: Record<string, unknown> | null) {
  const { children, ...rest } = props ?? {};
  // 无 children 时不要传第三参：否则 `children` 会变成 `[undefined]`，
  // 而判据的 kids() 只过滤 null/false、不过滤 undefined。
  if (children === undefined) return createElement(type, rest);
  return Array.isArray(children)
    ? createElement(type, rest, ...children)
    : createElement(type, rest, children);
}

/**
 * 单子节点版（自动运行时对 1 个子节点调这个）。
 * @param type 元素类型
 * @param props 属性
 * @returns vnode
 */
export function jsx(type: unknown, props: Record<string, unknown> | null) {
  return el(type, props);
}

/**
 * 多子节点版（children 是数组）。
 * @param type 元素类型
 * @param props 属性
 * @returns vnode
 */
export function jsxs(type: unknown, props: Record<string, unknown> | null) {
  return el(type, props);
}

/** 开发态变体（Vitest 的 esbuild 可能用 jsxDEV）。 */
export const jsxDEV = jsx;

/** Fragment（转发桩的稳定符号）。 */
export { Fragment };
