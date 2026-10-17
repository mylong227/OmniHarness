// Vite 配置：**root 必须是 `web/`，产物必须是 `web/dist/`**。
//
// ## 为什么 root 不是仓库根（这条是硬约束，不是偏好）
//
// 服务端静态托管把仓库 `web/` 目录当静态根（`src/cli/cliServerCmds.ts` 解析
// `…/dist/src/cli/../../../web`），且 `package.json#files` 发布的是 `web`。
// 换句话说：**发布出去后，`web/index.html` + `web/dist/*` 就是运行时的全部**。
// 若把 root 设为仓库根、产物落到别处，`serve` 会 404 白屏。
// 把 root 设成 `web/` 后，Vite 的默认行为恰好产出 `web/dist/assets/*` 与 `web/dist/index.html`，
// 与既有目录布局一致。
//
// ## 从"零打包器"迁移过来时保留了什么
//
// 旧形态是 `tsc` 直出原生 ESM（158 个文件、无打包器）。迁移到 Vite 后：
//   · 开发：Vite dev server（HMR）+ 把 `/rpc` `/events` 代理到后端（见 server.proxy）；
//   · 生产：Vite 默认单 bundle（带 hash）→ `web/dist/assets/`。
// 两条路径共用同一份 `web/index.html` 作为入口。

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/** 后端 dev 端口：`npm run dev` 先把 serve 起在这个端口，前端代理打过去。 */
const BACKEND_PORT = Number(process.env.OMNI_BACKEND_PORT ?? 8787);

export default defineConfig({
  root: resolve(import.meta.dirname, 'web'),
  // 相对基路径：产物里的 `assets/app.js` 用 `./assets/...` 引用。
  // 为什么不用默认的 `/`：前端既可能挂在站点根（serve 把 web/ 当静态根），
  // 也可能被反向代理到子路径下（`/omni/`）。相对基路径两种都成立，且与迁移前
  // （`import('./dist/main.js')`）的引用形态一致，减少行为差异。
  base: './',
  // React 插件：负责 JSX 转换与 Fast Refresh（开发期改组件不丢状态、不整页刷新）。
  // 源码里既有 JSX 语法（60 个 .tsx），也有 `React.createElement`（`deps.ts` 导出的宏调用）。
  plugins: [react()],
  // publicDir：**`web/vendor/` 直接作为公开目录**，内容平铺到产物根。
  //
  // 为什么不再维护 `web/public/vendor` 副本：那会造成两份同源文件（一份给 dev、一份给 build），
  // 迟早漂移。单一来源后：`web/vendor/markdown-it.min.js` → `web/dist/markdown-it.min.js`，
  // `index.html` 用根相对 `./markdown-it.min.js` 引用（dev 与 build 同一条路径）。
  //
  // 为什么这些库不走打包：`markdown.ts` 做**运行时特性检测**（`window.markdownit` 等），
  // 缺任一即回落到手写渲染器。交给 Rollup 打包会丢失全局注入、契约随之改变 ——
  // 那是后续阶段单独评估的迁移，不混在"换构建器"这一步。
  publicDir: resolve(import.meta.dirname, 'web', 'vendor'),
  build: {
    // 标准 Vite 产物目录：`web/dist/`（相对 root=web/）。
    //
    // 为什么**不能**直接输出到 `web/`（曾这样试过，是个错误）：Vite 会生成 `index.html`，
    // 而 `web/index.html` 是**源码入口**——产物覆盖源码后，下一次构建读到的入口就变成
    // 产物引用（`./assets/app.js`），构建随即自引用失败。源码与产物必须分开。
    //
    // 服务端要托管的正是这个目录（见 `src/cli/cliServerCmds.ts` 的 webDir 解析：
    // 优先 `web/dist`，开发态无产物时回落 `web/`）。
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
    // `keepNames`：**保留函数/类名**，代价是少量体积，换来的是可诊断性。
    //
    // 为什么这条对生产有实际价值（不是为了测试好看）：
    //   · 错误边界的降级面板要显示**组件栈**（`web/test/renderErrorBoundary.test.mjs` 明文断言
    //     栈里必须出现 `SessionPanel`）。压缩后组件函数名被抹掉，栈里只剩 `at r (…/app.js:1:2)`，
    //     用户拿到面板也定位不到是哪个组件崩了 —— 那正是该面板存在的意义；
    //   · 生产报错上报同样依赖这个。
    // 实测：默认压缩下 bundle 里 `SessionPanel` 出现 0 次；开启后保留。
    minify: 'esbuild',
    rollupOptions: {},
  },
  // esbuild 选项在此层生效（`build.minify` 用的是同一套）。
  esbuild: {
    keepNames: true,
  },
  server: {
    port: 5173,
    strictPort: false,
    // 前后端分离开发：RPC 走 POST /rpc（JSON-RPC 2.0），事件走 GET /events（SSE）。
    // 两者都代理到后端，前端代码里仍用同源相对路径（`/rpc`），无需读环境变量拼地址。
    proxy: {
      '/rpc': { target: `http://127.0.0.1:${BACKEND_PORT}`, changeOrigin: false },
      '/events': { target: `http://127.0.0.1:${BACKEND_PORT}`, changeOrigin: false },
      // 工作区文件下载 / 预览（GET /files）
      '/files': { target: `http://127.0.0.1:${BACKEND_PORT}`, changeOrigin: false },
    },
  },
  // 依赖预构建：React 走 npm，不再出现 vendor UMD 全局。
  // 不写 `resolve.alias` —— Vite 会从仓库根的 node_modules 正常解析裸标识符，
  // 手写 alias 反而会破坏 `react-dom/client` 这类子路径。
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client'],
  },
});
