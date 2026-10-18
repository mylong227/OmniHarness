// Vitest 配置：**双项目 workspace**（2026-10-17 测试栈统一后）。
//
// ## 为什么迁到 Vitest（而不是继续 `node --test`）
//
// 迁移前，88 个测试文件 `import '../dist/ui/**/xxx.js'` —— 读的是 `tsc` 直出的原生 ESM。
// 换成 Vite 单 bundle 后，`web/dist` 里只有一个带 hash 的 bundle，那些路径全部消失；
// 而 `node --test` **不能**直接执行 `.ts/.tsx` 源码（无转译层，且 31 个被 import 的模块是 JSX）。
// Vitest 复用 Vite 的转译管线，因此可以「测试直接 import 源码」——
// 这也是标准 Vite 项目的做法，顺带消掉了「跑测试前必须先构建」这条耦合。
//
// ## 2026-10-17 测试栈统一：后端判据并入 vitest
//
// `tests/unit` + `tests/integration`（544 个判据文件）从 `node:test` + 跑 `dist` 迁到
// **vitest 直跑源码**（`import '../../src/x.ts'`），与前端同栈。两个项目分开的原因：
//   · `web` 判据会各自起真 Chrome（11 个），并发互相抢资源产生**假红** ⇒ 必须串行；
//   · `node` 判据是纯进程内逻辑，并行安全且快得多（538 个文件串行要 10-20 分钟）。
//
// ## 兼容性：`node:test` 导入已全量换成 `vitest`（538→0），断言仍是 `node:assert`（语义一致）。

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 浏览器探针类测试（真 Chrome）耗时长，给足超时。
    testTimeout: 120000,
    hookTimeout: 60000,
    environment: 'node',
    // 与被替换的 `node --test` 行为对齐：不吞掉未处理的 rejection。
    dangerouslyIgnoreUnhandledErrors: false,
    reporters: ['default'],
    /**
     * 覆盖率（v8 直测源码）。
     *
     * ## 为什么放在**根**配置而不是 workspace 项目的 `test.coverage`
     *
     * 2026-10-18 实测：把 `coverage` 写在 `vitest.workspace.ts` 的 node 项目里，再用
     * `vitest run --project node --coverage.enabled` 跑，**项目级配置不生效**——
     * vitest 回落到默认 reporter（`text` + `html` 落到 `./coverage/`），
     * `json-summary` 压根没产出，于是 `scripts/coverageGate.mjs` 读不到
     * `.coverage/coverage-summary.json`（报"文件不存在"）。
     *
     * 放到根层后 CLI 与配置一致：`npm run coverage` 固定带 `--project node`，
     * 故只有后端源码被统计（前端是浏览器探针判据，不该计入后端覆盖率）。
     */
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // `json-summary` 是**判据真相源**（门禁消费它）；`text` 只供人读。
      // 不要加 `html`：439 个目录、数千文件，读过一次才知道它多大，且从没人看。
      reporter: ['json-summary', 'text'],
      reportsDirectory: '.coverage',
    },
    // 双项目定义见 vitest.workspace.ts（vitest 2.1 的 `test.workspace` 只接受
    // 工作区文件路径，内联数组是 3.0 的 `projects` 形态——本仓锁 vitest 2.1.9）。
  },
});
