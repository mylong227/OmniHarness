// 全局 React 类型提升（**只转引，不手写任何形状**）。
//
// 类型来源：官方 `@types/react`（G11/W1，2026-10-03）。
//
// ## 为什么还需要这个文件（2026-10-17 第二轮标准化后）
//
// 代码里有两类"不带前缀"的类型名来自历史写法：组件签名直接写 `ReactElement`（3 处）、
// `ReactNode`（2 处），而不是 `React.ReactElement`。改成限定前缀是一次纯风格性的大范围改动，
// 收益低于风险，所以保留这两行转引。
//
// ## 本次删掉了什么
//
// 删除了 `ReactApi` / `ReactDOMApi` 两个全局类型。它们原本是**给 `deps.ts` 的注入契约**
// 用的（那个文件从 `window.React` 取 UMD 全局，需要一个类型描述"被注入的东西长什么样"）。
// 现在 `deps.ts` 已删除、UI 直接 `import * as React from 'react'`，两者都没有消费者。
// 留着会传递错误信号（好像还存在一个"注入的 UMD 全局"）。
//
// 维护口径（不变）：新增未限定前缀的类型名时，**只允许**在此加一行 `type X = React.X;` 的
// 转引；不允许展开任何接口字段（早期那份手写垫片 `react-shim.d.ts` 正是因此被删除）。
import * as React from 'react';

declare global {
  /** 官方 React 元素类型（等价 `React.ReactElement`）。 */
  type ReactElement = React.ReactElement;
  /** 官方 React 子节点类型（等价 `React.ReactNode`）。 */
  type ReactNode = React.ReactNode;
}
