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
    /**
     * 体积警告阈值：**1200 KB**（默认 500 KB）。
     *
     * 为什么调高：这是**单 bundle** 的产物（目标明确要求 Vite 默认单 bundle，不做 manualChunks）。
     * 单 bundle 必然把 react(147KB) + markdown-it(120KB) + katex(266KB) + highlight-common(120KB)
     * 与应用代码合进一个文件，实测约 1030 KB —— 与迁移前的**总传输量**基本持平
     *（此前是 app 464KB + markdown-it 121KB + katex 275KB + highlight 121KB，共 4 个文件）。
     *
     * 为什么不直接消警告或调成 Infinity：那会让阈值失去意义。1200 KB 是"当前实测 + 约 15% 余量"，
     * 一旦依赖或应用代码膨胀越过它，构建会重新警告 —— 那才是需要有人看一眼的时刻。
     */
    chunkSizeWarningLimit: 1200,
    /**
     * vendor 分块（2026-10-28 W1，antd 迁移基建；2026-10-29 W4 分块改造）。
     *
     * 为什么：antd 基座与 react 基座必须与应用码分开记账——UI_LIBRARY_UPGRADE §0.5 的预算
     * 重写就是按「entry + vendor 总量」口径定的，且 vendor chunk 跨版本 content-hash 稳定，
     * 发版只失效应用 chunk。
     *
     * 为什么用**函数形态**：object 形态只匹配 'react' 精确 id，抓不到 react/cjs/* 重导出
     * （W0 实测产出 0KB 空 chunk）；按 node_modules 路径前缀分桶才可靠。
     *
     * ## 2026-10-29 分块改造（看板 §178 → §179）：antd 默认进 vendor，仅「面板级组件族」放行
     *
     * 旧规则把**任何** antd import 都塞进 vendor（首屏）：面板虽是异步块，其 antd 依赖
     * （Table/Form/DatePicker…）仍全部落在首屏——审计面板接一个 Table 就让 vendor
     * 232 → 310.7KB，闸只剩 ~19KB，再加两个重组件必红。
     *
     * 新规则 = **默认 vendor + 面板族 denylist → 统一异步块 `panel-antd`**（而不是「壳层白名单」）：
     *   · 默认 vendor 保证共享内核（`_util` / `theme` / `style` / config-provider / locale /
     *     cssinjs / icons / dayjs）永远在首屏基座里——它们被壳层组件可达，若按字面白名单漏掉
     *     任何一个，该模块会落进 **entry**（比落 vendor 更糟）；
     *   · denylist 里的「面板级组件族」返回 `panel-antd`：一个**可预测命名的异步共享块**。
     *     为什么不返回 undefined（随导入方走）：面板族常被多个异步面板共享（menu 被 ConsoleView
     *     与 Table 的 FilterDropdown 共用），Rollup 会把共享模块合成**匿名共享块**并按 facade
     *     模块命名为 `index-*.js`——与 entry 的文件名前缀相撞，预算脚本与单入口判据全被污染
     *     （2026-10-29 实测）。命名块同时保证：只被异步面板可达 ⇒ 不进 modulepreload（首屏不背），
     *     且跨面板只下载一次。
     *
     * denylist 的**准入纪律**（违反会把面板库打进 entry 或多切一个首屏共享块）：一个族只有当
     * 「没有任何 vendor 侧（壳层/静态文件）可达的模块导入它」时才能进 denylist。已核实的内部引用：
     *   · `antd/es/app`（ThemeProvider 静态用）内部引 `message` / `notification`
     *     ⇒ 这两族**必须留在 vendor**，不可 denylist；
     *   · `@rc-component/tabs`（Tabs=vendor）的「更多」下拉引 rc-dropdown/rc-menu
     *     ⇒ 这两个 rc 包**必须留在 vendor**；
     *   · `antd/es/modal`（vendor）引 `drawer/useFocusable` 与 `skeleton`；Tag/Card 的 style 引
     *     color-picker 的 ColorPresets（进而引 collapse）⇒ drawer/skeleton/collapse 留在 vendor；
     *   · menu 内部引 layout/Sider 与 tooltip；tooltip 引 table 的 MeasureRowContext ⇒
     *     menu/layout/tooltip 进 denylist，MeasureRowContext 由 carve-out 回收 vendor；
     *   · **跨族小件一律 carve-out 回 vendor**（判定顺序在 denylist 之前）：全部 style/ 目录、
     *     form 的 context、table 的 MeasureRowContext、各族 locale/ 目录——antd/locale/zh_CN
     *     与 _util/config-provider 会静态引到它们；
     *   · Tree（壳层）走 `@rc-component/tree` → `@rc-component/checkbox`/`virtual-list`
     *     ⇒ 这两个 rc 包不可 denylist（antd/es/checkbox 可以，其 style/ 由 carve-out 回收）。
     * denylist 漏了某个面板族 = 它静默落 vendor（vendor 闸会红，不破坏正确性）；denylist 错加
     * 了壳层可达的族 = 它落 entry（vendorFreePipeline 的分块边界判据会红）。两边都有闸。
     *
     * markdown-it / katex / highlight.js 仍留在入口（与迁移前一致）；katex 走异步块不变。
     */
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id))
            return 'vendor-react';
          // 共享副产物先行回收进 vendor（顺序在 denylist 之前）——antd 跨族引用这些小模块，
          // 它们被 vendor 侧可达，落 panel-antd 会把该块拖回首屏（详见上方纪律注释）：
          // style/ 目录（CSS-in-JS，跨族互引）、form 的 context、tooltip 的 UniqueProvider
          //（config-provider 引用）、table 的 MeasureRowContext、组件族与 rc 包的 locale/ 目录
          //（antd/locale/zh_CN 静态引到它们，含 lib/ 路径）。
          if (
            /[\\/]node_modules[\\/](?:antd[\\/](?:es|lib)[\\/](?:.*[\\/]style[\\/]|form[\\/](?:context|validateMessagesContext)\.js|tooltip[\\/]UniqueProvider[\\/]|table[\\/]TableMeasureRowContext\.js|(?:pagination|calendar|date-picker|time-picker)[\\/]locale[\\/]|locale[\\/])|@rc-component[\\/](?:picker|pagination)[\\/](?:es|lib)[\\/]locale[\\/])/.test(
              id,
            )
          )
            return 'vendor-antd';
          // 面板级 antd 组件族：不进 vendor，统一进可预测命名的异步共享块 panel-antd。
          if (
            /[\\/]node_modules[\\/]antd[\\/]es[\\/](alert|auto-complete|calendar|cascader|checkbox|date-picker|descriptions|dropdown|form|grid|row|col|image|input|input-number|layout|list|mentions|menu|pagination|popconfirm|popover|progress|qr-code|qrcode|radio|rate|result|segmented|select|slider|spin|statistic|steps|switch|table|time-picker|timeline|tooltip|tour|transfer|tree-select|upload)[\\/]/.test(
              id,
            )
          )
            return 'panel-antd';
          // 同族的 @rc-component 内部实现：跟上组件族一起走 panel-antd。
          // 注意**不在列**的 rc 包及其原因：
          //   · trigger/motion/util/context/portal/checkbox/virtual-list/overflow/dialog——
          //     被 vendor 侧组件（Modal/Tabs/Tree）可达；
          //   · dropdown/menu——`@rc-component/tabs` 的「更多」下拉引用；
          //   · form + async-validator——`antd/es/form/context`（被 _util/config-provider 引用，
          //     carve 回 vendor）内部整包引用 @rc-component/form，validateUtil 又引 async-validator。
          // 漏一个都会让 panel-antd 被 vendor 静态可达 → 循环块（panel→vendor→panel）。
          if (
            /[\\/]node_modules[\\/]@rc-component[\\/](cascader|image|input|input-number|listy|mentions|mini-decimal|pagination|picker|progress|segmented|select|slider|steps|switch|table|tooltip|tour|tree-select|upload)[\\/]/.test(
              id,
            )
          )
            return 'panel-antd';
          // 历史口径三库随 entry（迁移前形态，预算注释与判据按 entry 桶记它们的体积）。
          if (/[\\/]node_modules[\\/](katex|markdown-it|highlight\.js)[\\/]/.test(id))
            return undefined;
          // 其余一切 npm 依赖**一律 vendor**（构造上完备）：antd 生态的第三方跟随包
          // （scroll-into-view-if-needed / compute-scroll-into-view / throttle-debounce /
          // babel helpers 等）若不显式归桶，会随导入方漂进 panel-antd，而它们同时被 vendor
          // 侧引用——这正是 manualChunks 循环块（panel→vendor→panel）的成因（2026-10-29 实测）。
          // 全部收进 vendor 后，panel-antd 的成员 = 面板 denylist 命中的模块，边界可被静态枚举。
          if (/[\\/]node_modules[\\/]/.test(id)) return 'vendor-antd';
          return undefined;
        },
      },
    },
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
      // 运行时自述（右栏网页标签从 `/healthz.previewPort` 取工作区预览源端口）；
      // 不代理的话 dev 下该请求会落到 Vite 的 404，本地网页预览会显示"未启用"。
      '/healthz': { target: `http://127.0.0.1:${BACKEND_PORT}`, changeOrigin: false },
    },
  },
  // 依赖预构建：React 走 npm，不再出现 vendor UMD 全局。
  // 不写 `resolve.alias` —— Vite 会从仓库根的 node_modules 正常解析裸标识符，
  // 手写 alias 反而会破坏 `react-dom/client` 这类子路径。
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client'],
  },
});
