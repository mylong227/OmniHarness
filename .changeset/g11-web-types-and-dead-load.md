---
'@mylong227/omniharness': patch
---

Web 类型层换成官方 `@types/react`，并**订正**报告里"120 KB 死负载"的误判（G11）。

## 一、类型层：手写垫片 → 官方类型（顺带挖出一个真缺陷）

- 删除 `web/src/types/react-shim.d.ts`（≈5.5 KB 手写的 React API 子集：`ReactElement`/`ReactNode`/
  `ReactApi`/`ReactDOMApi`/JSX 元素类型…），改为 **devDependency `@types/react` + `@types/react-dom`**
  （18.3.x，与 vendor 的 React 18.3.1 **大版本对齐**）。
- 新增 `web/src/types/reactGlobals.d.ts`：**只做转引**（`type ReactElement = React.ReactElement` 等），
  不含任何手写 API 形状；`web/tsconfig.json` 开 `allowUmdGlobalAccess`（模块内引用 UMD 全局 `React`）。
  运行时仍走 vendor UMD、零打包器、零网络——**运行时依赖预算不变**（类型只在开发期）。

### 官方类型立刻挖出一个被掩盖的真缺陷

`App` 一直在给 `StreamView` 传 `reasoningOptions`，而 `StreamViewProps` **既没声明、渲染 `Composer`
时也没转发** ⇒ 会话实际的推理档位清单被**静默丢弃**，Composer 的推理选择器只能退回内置兜底列表。
旧垫片给未知属性留了索引签名"逃生舱"，这件事在类型层完全看不见。已在 `StreamViewProps` 补声明并转发。

另修正 5 处同类漂移（都是垫片写宽了）：`RightPanelProps.children` 必填→可选（App 用 `createElement`
第三参数传子节点）、`RenderErrorBoundary.render()` 返回 `unknown`→`ReactNode`（`unknown` 使它不能作为
`createElement` 的组件类型）、`ChangesTab` 的 `ref` 基类 `HTMLElement`→`HTMLDivElement`、
`SettingsTab.onSelectChange`/`RightPanel.onTabKey`/`Composer.onPaste` 的 DOM 事件参数→React 事件类型。

## 二、订正"死负载"误判 + 加守卫（**不删**）

报告 §3.5 第 5 条与 §4 的 W4 断言 `vendor/highlight.min.js`（118.9 KB）是死负载。**逐行复核后不成立**：
`ui/highlight.ts` 服务的是**右侧文件面板**（编辑器式分色），而 **markdown 渲染路径真的在用 highlight.js**
——`ui/markdown.ts` 的 `hasDeps()` 要求 `window.hljs` 存在，markdown-it 的 `highlight` 选项就调
`hljs.highlight(...)`。删掉 vendor 脚本 ⇒ 助手消息里的代码块**静默失去着色**（回落到转义后无色输出），
功能测试不会红——正是本仓反复治理的"静默退化"形态。**故本项不删，改为把"它是在用的"钉成契约。**

新增 `web/test/vendorAndTypeSource.test.mjs`（4 例）：
① `index.html` 必须加载 markdown 路径真实依赖的 vendor 脚本（含 `highlight.min.js`）；
② `markdown.ts` 必须仍从 `window.hljs` 取用并保留 markdown-it 的 `highlight:` 选项与 `hasDeps` 条件；
③ vendor 文件真实存在且非空（防"只留标签、文件被删"）；④ 手写垫片不得回归 + `@types/react` 仍在
devDependencies 且大版本与运行时对齐。

**变异测试**：从 `index.html` 删掉 `highlight.min.js`（即按误判结论动手）⇒ ① **变红**；回滚后全绿。

## 验证

`npm run typecheck`（含 `tsc -p web/tsconfig.json`）**零错误**；`npm run web:test` **300 项全过**
（原 296 + 新增 4）；`typecheck` / `lint` / `check --strict` / `arch:gate` / `audit:config-wiring` /
`audit:maturity` / `check:doc-links` / `api:check` / `audit:standard:delta` / `npm test` / `rust:test` 全绿。
报告 §3.5 第 5 条与 W4 状态改为**误判（已订正）**，§4 的 G11 行与看板第九轮横幅同步。
