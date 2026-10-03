// 依赖绑定：React / ReactDOM 以 UMD 全局方式本地内置（零网络依赖，见 web/vendor/）。
// 此处仅从 window 取出并再导出；UI 一律用 React.createElement 编写，不再经 htm 标签模板
// （2026-09-13 起 web/src 内 html`` 调用点已清零，vendor/htm.umd.js 也已从 index.html 摘除）。
// 类型来自官方 @types/react / @types/react-dom，并由 web/src/types/reactGlobals.d.ts 提升为全局
// （G11/W1：原先那份手写 react-shim.d.ts 已删除）。

/* global window */

const g = window as unknown as {
  React: ReactApi;
  ReactDOM: ReactDOMApi;
};

export const React = g.React;
export const ReactDOM = g.ReactDOM;
