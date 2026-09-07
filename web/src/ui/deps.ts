// 依赖绑定：React / ReactDOM / htm 以 UMD 全局方式本地内置（零网络依赖，见 web/vendor/）。
// 此处仅从 window 取出，并把 htm 绑定到 React.createElement，供各组件用 html`` 标签模板编写 UI。
// 类型来自 web/src/types/react-shim.d.ts（全局环境声明）。

/* global window */

const g = window as unknown as {
  React: ReactApi;
  ReactDOM: ReactDOMApi;
  htm: HtmFn;
};

export const React = g.React;
export const ReactDOM = g.ReactDOM;

/** htm 绑定 React.createElement 后的标签模板函数，等价于免打包器的 JSX。 */
export const html = g.htm.bind(g.React.createElement) as HtmFn;
