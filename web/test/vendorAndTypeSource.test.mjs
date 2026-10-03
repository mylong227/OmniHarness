// G11（2026-10-03 第九轮）：**web 运行时依赖与类型层来源**的契约守卫。
//
// ## 这个文件防的是两件已经在报告里写错/将要发生的事
//
// 1. **「≈120 KB 死负载」是误判**。报告 §3.5 第 5 条与 §4 的 W4 写着 `index.html` 里的
//    `vendor/highlight.min.js`（118.9 KB）是死负载（依据是"自研 `ui/highlight.ts` 已存在、
//    且其注释写明不引 highlight.js"）。**逐行复核后不成立**：`ui/highlight.ts` 服务于**右侧文件面板**
//    （编辑器式分色预览），而 **markdown 渲染路径真的在用 highlight.js**：
//    `ui/markdown.ts` 的 `hasDeps()` 要求 `window.hljs` 存在，且 markdown-it 的 `highlight`
//    选项就是调 `hljs.highlight(...)`。删掉 vendor 脚本 ⇒ 助手消息里的代码块**静默失去着色**
//    （`format.ts` 会回落到转义后无色输出），功能测试不会红。
//    ⇒ 本文件把"它是在用的"钉成契约，防止有人照错误结论删掉它。
//
// 2. **手写类型垫片不许回来**。W1 已把手写 `react-shim.d.ts`（≈5.5 KB，自建 React 子集）
//    换成官方 `@types/react` + 一份**只做转引**的 `reactGlobals.d.ts`。手写垫片不仅维护成本高，
//    还会**掩盖真实类型漂移**（迁移时即发现 App 传给 StreamView 的 `reasoningOptions` 被静默丢弃）。
//    ⇒ 断言垫片文件不存在、且官方类型仍在 devDependencies。
//
// 风格：与其它 web 测试一致，直读仓库文件做契约断言（不依赖浏览器）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(WEB_ROOT, '..');

/** 读一个仓库内文件（UTF-8）。 */
function read(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** 取 `index.html` 里 `<script src>` 的路径集合。 */
function scriptSources() {
  const html = read('web/index.html');
  return [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
}

test('index.html 必须加载 markdown 渲染路径真实依赖的 vendor 脚本（highlight.js 不是死负载）', () => {
  const sources = scriptSources().join('\n');
  for (const need of [
    'vendor/react.production.min.js',
    'vendor/react-dom.production.min.js',
    'vendor/markdown-it.min.js',
    'vendor/katex.min.js',
    // 关键一条：复核结论是它**在用**（见文件头），因此必须在列。
    'vendor/highlight.min.js',
  ]) {
    assert.ok(
      sources.includes(need),
      `index.html 未加载 ${need}：它被运行时代码真实依赖，删掉会造成静默功能退化`,
    );
  }
});

test('markdown 渲染路径确实调用 highlight.js（删 vendor 脚本会让代码块失色）', () => {
  const md = read('web/src/ui/markdown.ts');
  assert.match(md, /window\.hljs|hljs/, 'markdown.ts 必须仍从 window 取 hljs');
  assert.match(md, /highlight\s*:/, 'markdown-it 的 highlight 选项必须仍存在（这就是着色入口）');
  assert.match(
    md,
    /Boolean\(v\.hljs\)/,
    'hasDeps 必须仍把 hljs 列为就绪条件——它决定走"成熟依赖管线"还是"无色兜底"',
  );
});

test('vendor 脚本"在列"且"文件真实存在且非空"（防止只留标签、文件被删）', () => {
  for (const rel of ['web/vendor/highlight.min.js', 'web/vendor/markdown-it.min.js', 'web/vendor/katex.min.js']) {
    const abs = join(REPO_ROOT, rel);
    assert.ok(existsSync(abs), `${rel} 不存在`);
    assert.ok(statSync(abs).size > 1024, `${rel} 体积异常（${String(statSync(abs).size)} B）`);
  }
});

test('类型层来自官方包：手写垫片不得回归，且官方类型仍在 devDependencies', () => {
  assert.ok(
    !existsSync(join(WEB_ROOT, 'src/types/react-shim.d.ts')),
    '手写 shim（web/src/types/react-shim.d.ts）不得回归——它手写 React API 子集，会掩盖真实类型漂移',
  );
  const globals = read('web/src/types/reactGlobals.d.ts');
  assert.match(globals, /from 'react'/, 'reactGlobals.d.ts 必须从官方包转引类型');
  assert.ok(
    !/interface\s+ReactApi|createElement\(type: unknown/.test(globals),
    'reactGlobals.d.ts 只允许转引，不允许再展开手写 API 形状',
  );
  const pkg = JSON.parse(read('package.json'));
  assert.ok(
    typeof pkg.devDependencies['@types/react'] === 'string',
    '@types/react 必须在 devDependencies（运行时依赖预算不变，类型只在开发期）',
  );
  assert.ok(
    /^\^18\./.test(pkg.devDependencies['@types/react']),
    `@types/react 大版本必须与运行时 vendor 的 React 18 对齐，实为 ${String(pkg.devDependencies['@types/react'])}`,
  );
});
