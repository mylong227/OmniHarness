// 类型来源：**官方 `@types/react`**（G11/W1，2026-10-03 第九轮）。
//
// 本文件**不手写任何 React API 形状**——原先的 `react-shim.d.ts`（≈5.5 KB）手写了
// `ReactElement` / `ReactNode` / `ReactApi` / `ReactDOMApi` / JSX 元素类型等一整套子集，
// 每加一个用到的 API 都要人工补一笔，且在 React 升级时**不会**跟着更新（类型与运行时静默分叉）。
// 现在只做一件事：把官方类型里的名字**提升到全局**，供既有代码的全局风格
// （`React.createElement` 宏 + 直接写 `ReactElement` 的组件签名）继续使用。
//
// 为什么需要"提升"：`web/src` 是 ESM 模块，而运行时是 vendor 里的 **UMD 全局** `React`/`ReactDOM`
// （零打包器、零网络）。模块内引用 UMD 全局需要 `web/tsconfig.json` 的 `allowUmdGlobalAccess`；
// 而像 `ReactElement` 这类**类型名**在全局并不存在，故由本文件显式转引。
//
// 维护口径：新增未限定前缀的类型名时，**只允许**在此加一行 `type X = React.X;` 的**转引**；
// 不允许在此展开任何接口字段（那正是被删除的那份手写垫片）。
import * as React from 'react';
import * as ReactDOM from 'react-dom';

declare global {
  /** 官方 React 元素类型（等价 `React.ReactElement`）。 */
  type ReactElement = React.ReactElement;
  /** 官方 React 子节点类型（等价 `React.ReactNode`）。 */
  type ReactNode = React.ReactNode;
  /** UMD 全局 `React` 的 API 面（`deps.ts` 用它声明注入契约）。 */
  type ReactApi = typeof React;
  /**
   * UMD 全局 `ReactDOM` 的 API 面（`deps.ts` 用它声明注入契约）。
   *
   * 为什么要在官方类型上补一笔：React 18 起 `createRoot` 在**类型层**挪进了 `react-dom/client`
   * 子入口，而 `@types/react-dom` 的根模块类型里没有它。本工程的运行时是 vendor 里的
   * **react-dom UMD 单文件**（`web/vendor/react-dom.production.min.js`，实测含 `createRoot`），
   * 全局上没有子入口可分 ⇒ 在此按运行时真实能力补声明。这是**运行时事实的类型化**，不是绕过检查：
   * 若哪天换了不带 `createRoot` 的 ReactDOM，这里必须同步删掉（否则类型会撒谎）。
   */
  type ReactDOMApi = typeof ReactDOM & {
    createRoot(container: Element | DocumentFragment): { render(node: ReactNode): void };
  };
}
