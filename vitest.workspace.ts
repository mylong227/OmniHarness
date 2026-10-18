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
    // ## 桩文件项目（迁移期保留）
    //
    // 组件判据正在从「手写 React 替身」迁到「真实 React + RTL」。**已迁完的**放在下面的
    // `web-rtl` 项目里；这里跑**尚未迁移**的那些，仍需要 `react` 别名指向桩。
    //
    // 为什么拆两个项目而不是加运行时开关：别名是**模块解析**层面的东西，只能按项目/文件生效。
    // 运行时"有桩就用桩、没桩就用真 React"的开关虽然能共存，但会让"这段代码到底跑的是哪个
    // React"变成隐式状态——排查成本远高于两个显式项目。迁移完成后本块整体删除。
    resolve: {
      // 用**正则锚定**的数组形式（对象形式会把 `react/jsx-dev-runtime` 这类子路径一起改写）。
      alias: [
        { find: /^react$/, replacement: resolve(ROOT, 'web/test/hooksStub.ts') },
        { find: /^react\/jsx-runtime$/, replacement: resolve(ROOT, 'web/test/jsxRuntimeStub.ts') },
        {
          find: /^react\/jsx-dev-runtime$/,
          replacement: resolve(ROOT, 'web/test/jsxRuntimeStub.ts'),
        },
      ],
    },
    test: {
      name: 'web',
      include: ['web/test/**/*.test.ts'],
      // 已迁到 `web-rtl` 的文件必须排除，否则两个项目会各跑一遍（重复执行 + 双份真 Chrome 争抢）。
      exclude: [
        'web/test/auditTraceTabs.test.ts',
        'web/test/diagnosticsTab.test.ts',
        'web/test/format.test.ts',
        'web/test/graphResumeChip.test.ts',
        'web/test/vaultTab.test.ts',
      ],
      // 默认 `node`；**组件判据在自己的文件头声明** `// @vitest-environment jsdom`。
      //
      // 为什么不整项目切 jsdom（2026-10-18 实测）：13 条真 Chrome 判据会跑坏——它们自己拉起
      // 浏览器并通过 CDP 驱动，进程内一旦存在 jsdom 的全局 `window`/`document`，
      // 探针的行为与"没有 DOM 的宿主"不同（e2e / narrowReflow / popoverFit / shellDensity /
      // monochromeInvariant 等一起红）。环境按**文件**声明，两种判据各用各的宿主。
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

  {
    // ## 真实 React + RTL 项目（组件判据迁移目标）
    //
    // 不含 `react` 别名 ⇒ 组件真的用 npm 的 React 19；环境由各文件头的
    // `// @vitest-environment jsdom` 声明（不在项目层强制，避免影响同项目的非 DOM 判据）。
    // 串行：RTL 渲染比桩慢，并行收益不抵抖动风险。
    test: {
      name: 'web-rtl',
      include: [
        'web/test/auditTraceTabs.test.ts',
        'web/test/diagnosticsTab.test.ts',
        'web/test/format.test.ts',
        'web/test/graphResumeChip.test.ts',
        'web/test/vaultTab.test.ts',
      ],
      environment: 'jsdom',
      testTimeout: 120000,
      hookTimeout: 60000,
      fileParallelism: false,
    },
  },
];
