// Vitest 工作区：**双项目**（2026-10-17 测试栈统一；2026-10-18 前端测试栈收口为单一项目）。
//
// ## 为什么分两个项目
//
//   · `node`：后端判据（tests/unit + tests/integration）纯进程内逻辑，并行安全；
//     vitest 直跑 `.ts` 源码（`import '../../src/x.ts'`），与前端同栈。
//   · `web`：前端判据**只剩一套**——真实 React（无任何载入期垫片 / 别名）。
//     组件判据在文件头声明 `// @vitest-environment jsdom`，真 Chrome 判据自己拉起浏览器
//     并在 node 宿主里跑；两类混在同一项目会互相污染，故环境按**文件**声明、项目级保持 node。
//     文件级串行：真 Chrome 判据并发会抢 CPU/端口产生假红（见下方注释）。
//
// 两个项目都继承根 vitest.config.ts 的共享项（testTimeout / environment / reporters）。

import { resolve } from 'node:path';

/** 仓库根（工作区文件被 vitest 加载时 `import.meta.dirname` 可用）。 */
const ROOT = import.meta.dirname;

/**
 * **ASCII 临时目录**（2026-10-17 plugin 判据实测）。
 *
 * Windows 本机用户名含中文 ⇒ 默认 `%TEMP%` 是 `C:\Users\芭比咯\...`。Vite 加载器对**非 ASCII
 * 路径**做 percent-encoding 后再解析，实测报
 * `Failed to load url C:/Users/%E8%8A%AD.../plugins/pdf-read/index.js`——文件明明存在。
 * pluginLoader / pluginRegistry 的判据会在临时目录落盘示范插件再动态 `import()`，于是集体红。
 *
 * ⚠️ **只在这两个判据内部局部设 `process.env.TMP/TEMP`**，绝不能在本配置模块加载期改全局
 * ——否则 vite 的 SSR 转换缓存也落到 `.tmp/test-tmp`，被 WorkBuddy 的 broker fs-shim 以
 * EPERM 拦截（实测：全局改写会让 15 个文件 / 25 个用例连带失败）。`.tmp/` 已进 .gitignore。
 */
export const ASCII_TMP = resolve(ROOT, '.tmp', 'test-tmp');

export default [
  {
    test: {
      name: 'node',
      include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
      environment: 'node',
      // 重判据（spawn Chrome/Python/Worker）走跨进程资源池；普通判据仍全速并行。
      setupFiles: [resolve(ROOT, 'tests/setup/heavyResource.ts')],
      fileParallelism: true,
      // 注意：workspace 内联项目**不继承**根 vitest.config.ts 的 test 选项（vitest 2.1 实测），
      // 超时必须在这里逐项目声明——否则回落 5000ms 默认，spawn 类判据集体超时。
      testTimeout: 120000,
      // 钩子预算 **180s**（不是 60s）：有判据在 `beforeAll` 里 spawn 并**预热**外部引擎
      // （`layaBackend` 起 Python venv + 加载模型，单跑实测 14.5s）。60s 只在**独占**时够用；
      // 并行跑时多个 spawn 同时抢 CPU，实测该文件整文件级失败（5 个用例全 skip、报 hook 超时），
      // 而单跑 5/5 通过 —— 典型的"预算太紧导致的假红"。钩子慢不等于被测代码慢。
      hookTimeout: 180000,
      // Worker 线程源码回落态需要类型剥离（`WorkerEntryUrl` 在源码直跑时解析到 `.ts` 入口）。
      // 旗标经 fork 进程的 execArgv 下发，测试内 `new Worker()` 默认继承 ⇒ 整链生效。
      // （TMP/TEMP 的 ASCII 化在模块加载期改 process.env，见上方 ASCII_TMP 注释。）
      poolOptions: { forks: { execArgv: ['--experimental-strip-types'] } },
    },
  },
  {
    // ## 前端判据：**唯一一套**（真实 React + 真 Chrome，按文件声明宿主）
    //
    // 2026-10-18：组件判据已全量从「手写 React 替身（hooksStub / jsxRuntimeStub + react 别名）」
    // 迁到「真实 React + @testing-library/react + jsdom」。垫片与别名**已删除**，本文件不再有
    // `resolve.alias`——「这段代码跑的是哪个 React」不再有第二个答案。
    test: {
      name: 'web',
      include: ['web/test/**/*.test.{ts,tsx}'],
      // **已退役判据**（2026-10-18）：单色体系的"所有颜色必须是灰阶"不变量已被
      // `colorSystem.test.ts`（色相预算 + token 接线）取代。
      //
      // 为什么要显式排除而不是只删文件：本机有外部工具会把**已删除的已跟踪文件**从 HEAD
      // 还原回磁盘（`web/vendor/` 与 `polish.css` 都实测过，`vendorAndTypeSource.test.ts`
      // 的注释里也有同一现象）。判据文件被还原后会被 include 收进来，跑出一个"正确设计被判红"
      // 的假失败。排除是幂等的：文件在或不在，结果都一致。
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.{idea,git,cache,output,temp}/**',
        'web/test/monochromeInvariant.test.ts',
      ],
      // 默认 `node`；**组件判据在自己的文件头声明** `// @vitest-environment jsdom`。
      //
      // 为什么不整项目切 jsdom（2026-10-18 实测）：13 条真 Chrome 判据会跑坏——它们自己拉起
      // 浏览器并通过 CDP 驱动，进程内一旦存在 jsdom 的全局 `window`/`document`，
      // 探针的行为与"没有 DOM 的宿主"不同（e2e / narrowReflow / popoverFit / shellDensity /
      // monochromeInvariant 等一起红）。环境按**文件**声明，两种判据各用各的宿主。
      environment: 'node',
      // W1（antd 迁移）新增：jsdom 缺的布局全局（matchMedia / ResizeObserver / requestIdleCallback）
      // 统一在 setupWeb.ts 里「缺失才补」。setup 对 node 环境判据也无害（那里没有 window，全跳过）。
      setupFiles: [resolve(ROOT, 'web/test/setupWeb.ts')],
      // 同上：workspace 项目不继承根配置，超时逐项目声明。
      testTimeout: 120000,
      hookTimeout: 60000,
      /**
       * **文件级串行**（2026-10-17 实测后定为默认）。
       *
       * 11 个判据文件会各自启动真 Chrome（`chromeCleanup` / `e2e` / `shellDensity` /
       * `narrowReflow` / `streamScrollCoverage` / `renderErrorBoundary` …）。并发跑时它们争抢
       * CPU 与端口，实测出现**假红**：`chromeCleanup` 报"留下了子进程"、`renderErrorBoundary`
       * 拿不到渲染栈——单跑每条都过，串行跑全绿。
       *
       * 为什么让默认值偏向"慢但可信"：假红会让人不再信任判据，进而跳过它——那比多等 60 秒
       * 昂贵得多（本仓已有大量"某判据偶发红"的历史教训）。若只想快速迭代，可临时加
       * `--fileParallelism=true`，但那时的红需要单跑复核。
       */
      fileParallelism: false,
    },
  },
];
