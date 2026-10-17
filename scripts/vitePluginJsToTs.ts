// Vite/Vitest 插件：把 `./foo.js` 解析到 `./foo.ts` / `./foo.tsx`。
//
// ## 为什么需要它
//
// 本仓前端源码与测试**全都**用 `.js` 后缀书写相对 import（例如
// `import { mountApp } from './ui/App.js'`）。这不是笔误，是**Node ESM 的硬要求**：
// 浏览器/Node 解析相对模块时不猜扩展名，源码里必须写出"编译后"的扩展名。
// `tsc` 时代这条规则免费成立（`.ts` 编译产出 `.js`）。
//
// 迁到 Vite 后，解析改由 Vite 负责，而 Vite 默认**按字面**查找 ——
// `./ui/App.js` 找不到（磁盘上只有 `App.ts`）⇒ 测试与 dev server 双双 404。
// 两种解决办法：
//   ① 把全仓 import 改成不带扩展名（数千处，且丢掉 Node ESM 兼容性）；
//   ② 加一个 resolver 插件，在 `.js` 查不到时回落 `.ts` / `.tsx`（本文件）。
// 选 ②：源码形态零改动，且 `tsc`/Node 场景仍然正确。
//
// ## 只在"文件真的不存在"时才回落
//
// 必须先确认 `.js` 不存在，再试 `.ts`。否则真实存在的 `.js`（如 `public/` 下的产物）
// 会被错误地改写到同名 `.ts`，那类 bug 极难查。

import { existsSync } from 'node:fs';
import type { Plugin } from 'vite';

/**
 * 创建 `.js` → `.ts`/`.tsx` 回落插件。
 * @returns Vite 插件
 */
export function jsToTsResolver(): Plugin {
  return {
    name: 'omni:js-to-ts',
    // `enforce: 'pre'`：在 Vite 内置解析之前介入，否则默认解析器先抛"找不到"。
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // 只处理相对路径 + `.js` 结尾；裸标识符（react 等）与绝对路径交给默认解析。
      if (!source.startsWith('./') && !source.startsWith('../')) return null;
      if (!source.endsWith('.js')) return null;
      if (importer === undefined) return null;

      const base = new URL(source, 'file://' + importer.replace(/\\/g, '/'));
      const jsPath = decodeURIComponent(base.pathname);
      // Windows 盘符修正：/D:/a/b → D:/a/b
      const normalized = jsPath.replace(/^\/([A-Za-z]:)/, '$1');
      if (existsSync(normalized)) return null; // 真实存在，交给默认解析

      for (const ext of ['.ts', '.tsx']) {
        const candidate = normalized.slice(0, -3) + ext;
        if (existsSync(candidate)) {
          // 交回 Vite 走完整解析（含其它插件与 alias）
          return this.resolve(candidate, importer, { ...options, skipSelf: true });
        }
      }
      return null;
    },
  };
}
