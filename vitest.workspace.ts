// Vitest 工作区：**双项目**（2026-10-17 测试栈统一）。
//
// ## 为什么分两个项目
//
//   · `web`：11 个判据各自起**真 Chrome**，并发互相抢资源产生假红 ⇒ 文件级串行；
//     且需要把 `react` 别名到测试桩（hooksStub / jsxRuntimeStub）。
//   · `node`：544 个判据（tests/unit + tests/integration）纯进程内逻辑，并行安全；
//     vitest 直跑 `.ts` 源码（`import '../../src/x.ts'`），与前端同栈。
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
      // 旗标经 fork 进程的 execArgV 下发，测试内 `new Worker()` 默认继承 ⇒ 整链生效。
      // （TMP/TEMP 的 ASCII 化在模块加载期改 process.env，见上方 ASCII_TMP 注释。）
      poolOptions: { forks: { execArgv: ['--experimental-strip-types'] } },
    },
  },
  {
    resolve: {
      // 用**正则锚定**的数组形式，不能用对象形式。
      //
      // 对象形式 `{ react: ... }` 在 Vite 里是**前缀匹配**，会把 `react/jsx-dev-runtime`、
      // `react-dom` 这类子路径一起改写（实测报 `Cannot find module 'react/jsx-dev-runtime'`）。
      // 用 `/^react$/` 精确锚定，子路径各自单独处理。
      alias: [
        // `react` → 测试桩（2026-10-17，`deps.ts` 删除后）。
        // UI 现在直接 `import * as React from 'react'`；测试侧把该模块换成 hooksStub，
        // 它导出同名 API 并转发到"当前 runtime"，零 DOM 判据照旧工作。
        // （2026-10-17 测试栈统一：桩随判据一起 .mjs → .ts。）
        { find: /^react$/, replacement: resolve(ROOT, 'web/test/hooksStub.ts') },
        // 自动 JSX 运行时 → 垫片（把 jsx/jsxs 也导到桩上），详见 `web/test/jsxRuntimeStub.ts`。
        {
          find: /^react\/jsx-runtime$/,
          replacement: resolve(ROOT, 'web/test/jsxRuntimeStub.ts'),
        },
        {
          find: /^react\/jsx-dev-runtime$/,
          replacement: resolve(ROOT, 'web/test/jsxRuntimeStub.ts'),
        },
      ],
    },
    test: {
      name: 'web',
      include: ['web/test/**/*.test.ts'],
      environment: 'node',
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
