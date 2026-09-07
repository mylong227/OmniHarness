// 应用入口：在 #root 上挂载 React 应用。由浏览器以原生 ES Module 加载（见 index.html）。

import { mountApp } from './ui/App.js';

const root = document.getElementById('root');
if (root) {
  mountApp(root);
}
