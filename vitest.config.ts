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
    // 覆盖率不是本仓门禁项，不装 @vitest/coverage 依赖。
    reporters: ['default'],
  },
  resolve: {
    alias: {
      // 测试里可能残留 `../dist/...` 写法；映射到源码，便于渐进迁移。
      // 迁移完成后这条 alias 可以删掉（本阶段先留着，避免一次性漏改导致大面积红）。
      '/dist/': '/src/',
    },
  },
});
