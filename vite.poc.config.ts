// W0 PoC 独立构建配置：**绝不**影响主产物（web/dist）。
//
// ## 为什么单独一份 config（而不是给 vite.config.ts 加 input）
//
//   · 主产物的预算门禁（webBundleBudget / vendorFreePipeline）盯着 `web/dist/assets` 的
//     单入口形态；PoC 若混进同一份构建，会把门禁口径搅乱；
//   · PoC 用 `manualChunks` 拆 vendor-react / vendor-antd——那正是 W1 要给主构建引入的形态，
//     先在隔离环境里量出数字、写回规划，W1 再按实测改主配置；
//   · 产物落 `web/dist-poc`（gitignore 见 .gitignore 追加项），构建命令：
//     `npx vite build --config vite.poc.config.ts`。
//
// 主题 token / 密度样张见 web/src/ui/theme/*；页面本体见 web/src/poc/antdPoc.tsx。

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname, 'web'),
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-poc',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
    minify: 'esbuild',
    // PoC 允许大 chunk：量体积就是本轮目的，别让警告淹没结论。
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        poc: resolve(import.meta.dirname, 'web/poc/antd.html'),
      },
      output: {
        // 与 W1 主构建将要采用的 vendor 分块策略同形：react 基座与 antd 分开记账。
        // **函数形态**：object 形态只匹配 'react' 精确 id，抓不到 react/cjs/* 的重导出
        // （W0 实测产出 0KB 空 chunk）；按 node_modules 路径前缀分桶才可靠。
        manualChunks(id: string) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id))
            return 'vendor-react';
          if (/[\\/]node_modules[\\/](antd|@ant-design|rc-|dayjs)[\\/]/.test(id))
            return 'vendor-antd';
          return undefined;
        },
      },
    },
  },
});
