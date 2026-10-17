// 依赖绑定：React / ReactDOM 的唯一入口。
//
// ## 2026-10-17 迁移为 Vite 后的形态
//
// 旧形态（零打包器时代）：UI 代码**不得** `import ... from 'react'`——浏览器解析不了裸标识符，
// 运行时只能靠 `index.html` 用 `<script src="vendor/react.production.min.js">` 注入 UMD 全局，
// 本文件再从 `window.React` 取出来再导出。
// （`web/vendor/` 已于 2026-10-17 删除，React 现在直接从 npm 包 import。）
//
// 现在由 Vite 解析裸标识符并打包，所以**标准写法就是直接 import**：
//   · 生产构建：Vite 把 react 打进 bundle（`web/dist/assets/*.js`）；
//   · 开发：Vite dev server 依赖预构建 + HMR；
//   · 仍是零网络依赖——react 来自本地 `node_modules`，不连 CDN。
//
// ## 为什么还保留"桩可覆盖"这一层
//
// `web/test/hooksStub.mjs` 提供一套零 DOM 的假 React（25 个组件判据靠它跑，不需要浏览器）。
// 那些桩通过注册 `window.React` 注入自己，而本文件是 UI 取 React 的唯一出口 ——
// 只要这里优先用"已注入的桩"，测试无需改动即可继续工作。
// 判据：`web/test/mount.test.mjs` 等 25 个文件。
//
// 真实运行时 `window.React` 恒为 undefined（index.html 不再加载 UMD），
// 所以这条分支在生产构建里只是普通的空值判断，不引入额外体积。

/* global window */

import * as RealReact from 'react';
import * as RealReactDOM from 'react-dom';
import * as RealReactDOMClient from 'react-dom/client';

/**
 * 取测试环境注入的桩。
 * @param key 'React' | 'ReactDOM'
 * @returns 已注入的桩对象；生产运行时为 null
 */
function injected<T>(key: 'React' | 'ReactDOM'): T | null {
  const w = (typeof window !== 'undefined' ? window : undefined) as
    | (Record<string, unknown> & { React?: unknown; ReactDOM?: unknown })
    | undefined;
  const v = w?.[key];
  return v === undefined || v === null ? null : (v as T);
}

/** React（生产用 npm 包；测试环境用注入的桩）。 */
export const React: typeof RealReact = injected<typeof RealReact>('React') ?? RealReact;

/**
 * ReactDOM。
 *
 * ⚠️ React 18 起 `createRoot` **只**在 `react-dom/client` 子入口导出。从 `react-dom` 根模块
 * 取它虽然"能用"，但会在控制台打 `Warning: You are importing createRoot from "react-dom"
 * which is not supported`（2026-10-17 迁移后真机探针抓到的唯一一条告警）。
 * 这里把两个入口合并，并让 **client 覆盖根模块**：`createRoot` 用对的那个，
 * 其余 API（如 `flushSync` / `unmountComponentAtNode`）继续从根模块取。
 *
 * 测试桩只注入一个 `ReactDOM` 对象（内含桩 `createRoot`），故桩分支保持原样。
 */
/**
 * 合并后的 ReactDOM 类型：根模块 API + `react-dom/client` 的 `createRoot`/`hydrateRoot`。
 *
 * 为什么需要交叉类型：官方 `@types/react-dom` 的**根模块**类型里没有 `createRoot`
 * （React 18 起它只在 `react-dom/client` 子入口），而 UI 的挂载点是 `ReactDOM.createRoot(...)`。
 * 把两个入口的类型并起来，既保住既有调用形态，又不需要把 `createRoot` 的调用点全改一遍。
 */
type MergedReactDOM = typeof RealReactDOM & typeof RealReactDOMClient;

const mergedDOM = { ...RealReactDOM, ...RealReactDOMClient } as MergedReactDOM;

/** ReactDOM（生产用 npm 包合并入口；测试环境用注入的桩）。 */
export const ReactDOM: MergedReactDOM =
  injected<MergedReactDOM>('ReactDOM') ?? mergedDOM;
