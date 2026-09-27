/**
 * 评测仪器（`evals/*.mjs`）**可运行性**回归（2026-09-27 审计发现）。
 *
 * ## 为什么需要它（真实缺陷，不是假想）
 *
 * `evals/*.mjs` 是「两关」判定所依赖的仪器，但它们**不在任何门禁里**：`tsc` 不管 `.mjs`、
 * ESLint 的配置面也不覆盖它们、单测不 import 它们。于是它们**只在被人手动跑时才暴露破损**，
 * 而「没跑」恰恰是常态。本次审计实测到两类真实破损：
 *
 *  1. **陈旧导出名**：`jaccardOverlap` 早已从 `context/rankVeto` 的模块级函数改为
 *     `RankVetoOverlap` 类的静态方法，但 `rerank-ab` / `layered-recall-ab` / `layered-fusion-ab`
 *     三个 AB harness 仍按旧名解构 ⇒ 解构得到 `undefined`，跑到「否决器」那一关才 `TypeError`
 *     （即：**判定链条最关键的仪器已经死了，而没人知道**）。
 *  2. **重复解构名**（`const { Bm25Index, Bm25Index } = …`）：语法错误，文件**根本无法加载**
 *     （`military-chain-ab` / `military-chain2-ab` / `military-verdict` 三份）。
 *
 * ## 本测试查什么
 *
 *  ① 语法：`node --check` 等价物——用 TypeScript 解析器解析每个 `.mjs`，有语法诊断即失败；
 *  ② 解构导出存在性：对 `await importDist('a','b.js')` 形式的静态字面量导入，解析出目标模块
 *     （`dist/src/a/b.js`），逐个断言被解构的名字**确实被该模块导出**；
 *  ③ 重复解构名：同一解构列表里同名出现两次即失败（②会漏掉它，因为重复名本身是语法错误，
 *     但报错信息不指出是「重复」）。
 *
 * 诚实边界：只覆盖 `importDist(<字符串字面量…>)` 这一形态（本仓 22 份 harness 的主流写法）；
 * 计算路径拼接、条件导入等形态不在覆盖内。这已足以拦住上面两类真实破损。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（dist/tests/unit → 上溯三级）。 */
const ROOT = join(HERE, '..', '..', '..');
const EVALS = join(ROOT, 'evals');

/** 评测仪器文件名列表（`*.mjs`，排序保证确定性）。 */
const harnesses = readdirSync(EVALS)
  .filter((n) => n.endsWith('.mjs'))
  .sort();

/** 读取某 harness 的源码文本。 */
const textOf = (name: string): string => readFileSync(join(EVALS, name), 'utf8');

/** 从 importDist(...) 的字符串字面量参数里拼出 dist 模块相对路径。 */
const distPathOf = (name: string, args: string): string | undefined => {
  const parts = [...args.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2] ?? '');
  if (parts.length === 0 || parts.some((p) => p === '' || p.includes('${'))) return undefined;
  void name;
  return join(ROOT, 'dist', 'src', ...parts);
};

/** 抓出所有 `const { a, b } = await importDist(...)` 形态。 */
const destructured = (src: string): { names: string[]; args: string }[] => {
  const out: { names: string[]; args: string }[] = [];
  const re = /const\s*\{([^}]*)\}\s*=\s*await\s+importDist\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const names = (m[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    out.push({ names, args: m[2] ?? '' });
  }
  return out;
};

test('评测仪器语法可解析（拦住 `const { X, X }` 这类致命重复解构）', () => {
  const broken: string[] = [];
  for (const name of harnesses) {
    const text = textOf(name);
    // BOM + shebang：Node 直接加载会拒绝（实测 `node --check` 报在 `#!` 处），单列一条更好定位。
    if (text.charCodeAt(0) === 0xfeff && text.slice(1).startsWith('#!')) {
      broken.push(`${name}：文件带 UTF-8 BOM 且首行是 shebang ⇒ Node 拒绝加载（去掉 BOM 即可）`);
      continue;
    }
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    // `parseDiagnostics` 为内部字段，运行期可用；缺失时按「无诊断」处理（不制造假失败）。
    const diags =
      (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (diags.length > 0) {
      const first = ts.flattenDiagnosticMessageText(diags[0]?.messageText ?? '', ' ');
      broken.push(`${name}：${diags.length} 条语法诊断（${first}）`);
    }
  }
  assert.deepStrictEqual(broken, [], `有 harness 无法解析：\n${broken.join('\n')}`);
});

test('评测仪器解构的导出名在 dist 中真实存在（拦住重构后仪器静默失效）', async () => {
  const missing: string[] = [];
  for (const name of harnesses) {
    for (const { names, args } of destructured(textOf(name))) {
      const dup = names.filter((n, i) => names.indexOf(n) !== i);
      if (dup.length > 0) missing.push(`${name}：重复解构名 ${[...new Set(dup)].join(',')}`);
      const path = distPathOf(name, args);
      if (path === undefined) continue;
      let mod: Record<string, unknown>;
      try {
        mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
      } catch (e) {
        missing.push(`${name}：无法加载 ${path}（${e instanceof Error ? e.message : String(e)}）`);
        continue;
      }
      for (const n of names) {
        if (!(n in mod)) missing.push(`${name}：dist 模块未导出 \`${n}\``);
      }
    }
  }
  assert.deepStrictEqual(missing, [], `评测仪器取不到导出：\n${missing.join('\n')}`);
});

test('被测 harness 清单非空（防「目录改路径后本测试变成空转」）', () => {
  assert.ok(harnesses.length >= 20, `仅扫描到 ${harnesses.length} 份 harness，疑似路径失效`);
});
