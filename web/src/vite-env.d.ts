/// <reference types="vite/client" />
// Vite 客户端类型入口（**标准 Vite 项目必备**）。
//
// ## 它带来什么
//
// `vite/client` 声明了三件本仓真实依赖、却无法从 `.ts` 源码推断的东西：
//
//   1. **CSS 副作用导入**：`import '../styles/theme.css';` 否则 TS 会报「找不到模块」，
//      或（更糟）被当成 any 而不报——本仓 `web/src/main.ts` 一次 import 20 份样式表。
//   2. **`import.meta.env`**：`DEV` / `PROD` / `MODE` / `BASE_URL` 与 `VITE_*` 自定义变量的类型。
//   3. **静态资源导入**：`?url` / `?raw` / `?inline` 后缀，以及 `.svg` `.woff2` 等。
//
// ## 为什么单独一个文件而不是塞进 tsconfig 的 `types`
//
// `web/tsconfig.json` 里刻意写了 `"types": []`（不自动加载 `node_modules/@types`，
// 避免把 Node 的全局类型泄进浏览器代码）。三斜线指令是**显式**引用，不受 `types: []` 影响，
// 语义也更清楚：这是"本工程依赖 Vite 的客户端契约"，而不是"随便捡起了所有 @types"。
//
// 判据：`web/test/vendorAndTypeSource.test.mjs` 断言本文件存在且含 `vite/client` 引用
//（它同时防住"有人误删"与"有人把 types 改成通配"）。
