// 应用入口（标准 Vite SPA）：样式 → 挂载。
//
// ## 为什么样式改成在这里 import（2026-10-17 第二轮标准化）
//
// 迁移前样式是 `web/index.html` 里的 20 条 `<link rel="stylesheet">`，加载顺序直接决定
// 级联顺序（`theme` 打底 → `minimal` 是唯一视觉事实源 → `highlight` 最后覆盖语法色）。
// 这能用，但不是标准 Vite 项目的形态：标准做法是**在入口 import CSS**，由 Vite 统一
// 打包成 `assets/*.css` 并在产物 HTML 里注入一条 `<link>`。
//
// 换过来之后的好处：
//   · 样式的依赖关系写进代码图（"谁在谁的后面"变成 import 顺序，而不是 HTML 里的位置）；
//   · 少一次"改了 CSS 忘记在 index.html 挂 link"的静默失效（那正是 `a11yContrast`
//     门禁里「孤儿样式表」那条判据一直在防的事）；
//   · 产物只有一条 CSS 请求。
//
// ⚠️ **顺序即级联优先级，不得重排**。判据：`web/test/a11yContrast.test.mjs`
// （它检查本文件的 import 顺序与 `styles/` 下的文件集合一一对应）。
import '../styles/theme.css'; // 唯一色彩事实源：token / reset / 原生控件
import '../styles/layout.css'; // 三栏骨架
import '../styles/components.css'; // 可复用组件
import '../styles/chat.css'; // 对话流基础
import '../styles/todo.css'; // 计划进度条（输入框上方）
import '../styles/tokens.css'; // 字体族补充
import '../styles/base.css'; // 全局底子：滚动条 / 选区 / 焦点
import '../styles/overlays.css'; // 浮层
import '../styles/resilience.css'; // 错误边界 / 无障碍
import '../styles/shell.css'; // 三栏壳层
import '../styles/minimal.css'; // 「纸与墨」设计体系：唯一视觉事实源
import '../styles/console.css'; // 工作台控制台（设置中心）：分组导航 + 卡片式设置行
import '../styles/highlight.css'; // **必须最后**：语法色要盖住前面的基线

import { mountApp } from './ui/App.ts';

const root = document.getElementById('root');
if (root) {
  mountApp(root);
}
