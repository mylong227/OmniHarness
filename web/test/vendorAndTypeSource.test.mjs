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
import { test } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

test('index.html 不得再加载任何 UMD vendor 脚本（2026-10-17 全部改为 npm import）', () => {
  const sources = scriptSources().join('\n');
  // 迁移历史（这条判据的意图随形态演进，但守的是同一件事：依赖必须**真的被加载**）：
  //   · 2026-10 之前：四个库都以 UMD `<script>` 注入，判据要求它们"在列"；
  //   · 2026-10-17 Vite 化第一步：React 改 npm，要求 React UMD 不在列、另三个仍在列；
  //   · 2026-10-17 第二步（本判据现状）：markdown-it / KaTeX / highlight.js 也改成
  //     `web/src/ui/markdown.ts` 的 npm import（Vite 打包），`web/vendor/` 已整体删除。
  //     于是**宿主页里不应再有任何一个 UMD 脚本**——只剩 `src/main.ts` 一个模块入口。
  //
  // 反向断言比正向更本质：只要有人把 UMD 加回来，就会出现"两套运行时"
  //（双份 React / 双份 hljs），表现为 hooks 失效或全局被覆盖，极难排查。
  for (const forbidden of [
    'vendor/react.production.min.js',
    'vendor/react-dom.production.min.js',
    'vendor/markdown-it.min.js',
    'vendor/katex.min.js',
    'vendor/highlight.min.js',
    'markdown-it.min.js',
    'katex.min.js',
    'highlight.min.js',
  ]) {
    assert.ok(
      !sources.includes(forbidden),
      `index.html 不得再加载 UMD 脚本「${forbidden}」：该库已改为 npm import（双份运行时会静默出问题）`,
    );
  }
  // 正向：唯一入口必须是源码模块（Vite 负责转译与打包）。
  assert.ok(sources.includes('./src/main.ts'), 'index.html 必须以 ./src/main.ts 作为唯一入口');
});

test('React 直接从 npm 包 import：deps.ts 间接层已彻底删除', () => {
  // 2026-10-17 第三轮：`web/src/ui/deps.ts` 已删除。
  //
  // 它曾是「零打包器 + UMD 全局」时代的收口点：从 `window.React` 取 UMD 全局再导出，
  // 附带一个 `injected()` 分支给测试注入桩。迁移到 Vite 后这两件事都不需要了——
  // UI 直接 `import * as React from 'react'`，测试侧由 vitest 的 `resolve.alias`
  // 把 `react` 指到 `web/test/hooksStub.mjs`（不再靠全局注入）。
  //
  // 这条判据因此从"deps.ts 必须 import"翻转为"deps.ts 必须不存在"，并守住新形态。
  assert.ok(
    !existsSync(join(WEB_ROOT, 'src', 'ui', 'deps.ts')),
    'deps.ts 间接层不得回归：UI 应直接 import react（否则就是两套 React 取用方式）',
  );

  // 抽样三个层级，确认都走标准写法（而不是漏改的 deps 导入）。
  for (const rel of ['web/src/ui/App.ts', 'web/src/ui/components/RightPanel.tsx', 'web/src/main.ts']) {
    const src = read(rel);
    assert.ok(
      !/deps\.js/.test(src),
      `${rel} 仍在引用已删除的 deps.js`,
    );
  }
  assert.match(read('web/src/ui/App.ts'), /import \* as React from 'react'/, 'App.ts 必须直接 import react');
  assert.match(
    read('web/src/ui/App.ts'),
    /from 'react-dom\/client'/,
    'createRoot 必须来自 react-dom/client（React 18+ 唯一合法入口）',
  );

  // 反向：整个 web/src 里不得再出现「读 window.React」或「引用 deps.js」。
  // 这两者是同一种退化的两面——只要有一个文件绕回全局注入，就会出现两套 React 取用方式，
  // 表现为 hooks 失效或 context 读不到（极难查）。全量扫，不抽查。
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/u.test(entry.name)) {
        const src = readFileSync(full, 'utf8');
        // 只看代码，不看注释里的历史说明。
        const code = src
          .split('\n')
          .filter((line) => {
            const s = line.trim();
            return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
          })
          .join('\n');
        if (/window\.React|deps\.js/u.test(code)) offenders.push(full.replace(WEB_ROOT, 'web'));
      }
    }
  };
  walk(join(WEB_ROOT, 'src'));
  assert.deepEqual(offenders, [], `这些文件仍走全局注入 / 已删除的 deps.js：\n${offenders.join('\n')}`);
});

test('markdown 渲染路径确实用 highlight.js（npm import，不再是 window 全局）', () => {
  const md = read('web/src/ui/markdown.ts');
  // 着色入口仍必须存在：markdown-it 的 `highlight` 选项是唯一的着色点。
  assert.match(md, /highlight\s*:/, 'markdown-it 的 highlight 选项必须仍存在（这就是着色入口）');
  // 依赖必须来自 npm，而不是 UMD 全局（后者已随 web/vendor 删除而消失）。
  assert.match(
    md,
    /from 'highlight\.js\/lib\/common'/,
    'highlight.js 必须 npm import（common 子集：全量入口会让 bundle 多 800KB）',
  );
  assert.match(md, /from 'markdown-it'/, 'markdown-it 必须 npm import');
  assert.match(md, /from 'katex'/, 'katex 必须 npm import');
  assert.match(md, /import 'katex\/dist\/katex\.min\.css'/, 'KaTeX 样式必须由源码 import（字体随 Vite 进 assets/）');
  // 反向：不得再读 UMD 全局。
  //
  // 注意必须**剔除注释行**再判：本文件历史说明里会提到 `window.markdownit / window.katex /
  // window.hljs`（"迁移前是这么干的"），那是留痕而不是代码。首版没剔注释，判据因此假红。
  const mdCode = md
    .split('\n')
    .filter((line) => {
      const s = line.trim();
      return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
    })
    .join('\n');
  assert.ok(
    !/window\.markdownit|window\.katex|window\.hljs/.test(mdCode),
    'markdown.ts 不得再读 window.* UMD 全局（vendor 已删除，读了只会拿到 undefined）',
  );
});

test('web/vendor 未被跟踪、未进产物、未被引用（依赖统一走 npm）', () => {
  // 为什么不断言"磁盘上不存在"：本机会有外部工具（工作区检查点/同步）把已删除的
  // **已跟踪文件**从对象库还原回磁盘 —— `web/styles/polish.css` 与 `web/vendor/` 都实测过。
  // 那种还原**不进 git 索引**、也**不被任何配置引用**，因此是惰性的；
  // 用它做断言只会制造"看环境而红"的假红。真正要守的是三条可保证的事实：
  //
  //   ① 未被 git 跟踪（否则会被提交、被发布出去）；
  //   ② 未被 `publicDir` 复制进产物（否则 dist 根会冒出 markdown-it.min.js 这类文件）；
  //   ③ 宿主页与配置都不引用它。
  const cfg = read('vite.config.ts');
  assert.ok(!/publicDir/.test(cfg), '① vite.config.ts 不得再配置 publicDir（没有静态公开目录了）');

  // ② 产物根不得出现 vendor 的 UMD 文件（这条比"目录在不在"更本质：
  //    即使目录被还原，只要没进产物，运行时就不可能用到它）。
  const dist = join(WEB_ROOT, 'dist');
  if (existsSync(dist)) {
    for (const legacy of ['markdown-it.min.js', 'katex.min.js', 'highlight.min.js', 'react.production.min.js']) {
      assert.ok(
        !existsSync(join(dist, legacy)),
        `② 产物根出现了旧 UMD 文件 ${legacy}：publicDir 可能又被指回 web/vendor`,
      );
    }
  }

  // ③ 宿主页引用（已在上面两条判据里正向断言，这里再守一次"根相对 UMD 引用"）。
  const html = read('web/index.html');
  assert.ok(
    !/<script src="\.\/(?:markdown-it|katex|highlight|react)/.test(html),
    '③ index.html 不得再有 UMD 脚本引用',
  );
});

test('标准 Vite 工程的三个必备件：vite-env.d.ts / StrictMode / .tsx 纳入 lint', () => {
  // ① `vite-env.d.ts` —— CSS 副作用导入、`import.meta.env`、资源后缀的类型来源。
  //    缺了它，`import '../styles/theme.css'`（本仓 20 条）在类型层无处可依。
  const envDts = join(WEB_ROOT, 'src', 'vite-env.d.ts');
  assert.ok(existsSync(envDts), 'web/src/vite-env.d.ts 必须存在（标准 Vite 工程必备）');
  assert.match(
    readFileSync(envDts, 'utf8'),
    /\/\/\/ <reference types="vite\/client" \/>/u,
    'vite-env.d.ts 必须显式引用 vite/client（web/tsconfig 的 types:[] 不会自动带进来）',
  );

  // ② StrictMode —— 开发态双跑，逼出"副作用没清理 / 依赖写漏"这类只在并发渲染下犯的错。
  assert.match(
    read('web/src/ui/App.ts'),
    /React\.StrictMode/u,
    'mountApp 必须把树包进 React.StrictMode（标准 React 模板默认形态）',
  );
  // 桩必须跟着有：否则 createElement(undefined) 会造出 type=undefined 的节点，
  // 表现是"挂载了但什么都没渲染"（已踩过一次）。
  const stub = read('web/test/hooksStub.mjs');
  assert.match(stub, /export const StrictMode =/u, 'hooksStub 必须导出 StrictMode（react 模块替身要完整）');

  // ③ `.tsx` 必须纳入 lint —— 2026-10-17 之前只写了 `**/*.ts`，
  //    60 个组件文件（约 116 KB）从未被 lint，属于"整层代码在门禁之外"。
  const eslintCfg = read('eslint.config.mjs');
  assert.match(
    eslintCfg,
    /files: \['\*\*\/\*\.ts', '\*\*\/\*\.tsx'\]/u,
    "eslint 配置必须同时覆盖 **/*.ts 与 **/*.tsx（否则组件层不受任何 lint 约束）",
  );
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
    /^\^19\./.test(pkg.devDependencies['@types/react']),
    // 2026-10-17 起 React 升 19（vendor UMD 早已删除，类型大版本只与 npm 运行时对齐）。
    `@types/react 大版本必须与 npm 运行时 React 19 对齐，实为 ${String(pkg.devDependencies['@types/react'])}`,
  );
});
