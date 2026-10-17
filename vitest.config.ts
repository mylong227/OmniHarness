// Vitest 配置：标准 Vite 项目的测试栈。
//
// ## 为什么必须迁到 Vitest（而不是继续 `node --test`）
//
// 迁移前，88 个测试文件 `import '../dist/ui/**/xxx.js'` —— 读的是 `tsc` 直出的原生 ESM。
// 换成 Vite 单 bundle 后，`web/dist` 里只有一个带 hash 的 bundle，那些路径全部消失；
// 而 `node --test` **不能**直接执行 `.ts/.tsx` 源码（无转译层，且 31 个被 import 的模块是 JSX）。
// Vitest 复用 Vite 的转译管线，因此可以「测试直接 import 源码」——
// 这也是标准 Vite 项目的做法，顺带消掉了「跑测试前必须先构建」这条耦合。
//
// ## 兼容性：79/88 个文件用 `node:test` + `node:assert`
//
// Vitest 原生支持这两个入口（`test`/`describe`/`assert` 语义一致），
// 所以迁移只需要把 import 路径从 `../dist/...` 改成 `../src/...`，断言代码一行不用改。
//
// ## 环境
//
// 默认 `node`：绝大多数判据是零 DOM 的纯逻辑（模型/控制器/纯函数）。
// 需要 DOM 的（浏览器行为）本来就走真实 Chrome CDP 探针，不靠 jsdom 模拟。

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { jsToTsResolver } from './scripts/vitePluginJsToTs.js';

export default defineConfig({
  // 把源码里的 .js 相对 import 解析到 .ts/.tsx（见插件头注释）。
  plugins: [jsToTsResolver()],
  test: {
    include: ['web/test/**/*.test.mjs'],
    // 浏览器探针类测试（真 Chrome）耗时长，给足超时。
    testTimeout: 120000,
    hookTimeout: 60000,
    environment: 'node',
    // 与被替换的 `node --test` 行为对齐：不吞掉未处理的 rejection。
    dangerouslyIgnoreUnhandledErrors: false,
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
    // 覆盖率不是本仓门禁项，不装 @vitest/coverage 依赖。
    reporters: ['default'],
  },
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
      { find: /^react$/, replacement: resolve(import.meta.dirname, 'web/test/hooksStub.mjs') },
      // 自动 JSX 运行时 → 垫片（把 jsx/jsxs 也导到桩上），详见 `web/test/jsxRuntimeStub.mjs`。
      {
        find: /^react\/jsx-runtime$/,
        replacement: resolve(import.meta.dirname, 'web/test/jsxRuntimeStub.mjs'),
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: resolve(import.meta.dirname, 'web/test/jsxRuntimeStub.mjs'),
      },
    ],
  },
});
