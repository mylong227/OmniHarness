/**
 * 铁律「第三方导入」规则的**动态导入**判据（2026-10-06 第五十七轮 ②收口）。
 *
 * ## 它锁的是什么
 *
 * 修复前的形态：`scripts/check.mjs` 的导入正则只认 `import x from '…'` / `import '…'` /
 * `require('…')`，**不认 `await import('pkg')`** ⇒ 「第三方导入须准入」与「核心与端口层零第三方」
 * 这两条**阻断规则对动态导入永远无法失败**（而 `architectureGate.mjs` 的正则却匹配 `import(`，
 * 两个脚本口径互相矛盾）。
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | 从 `check.mjs` 源里抽出的导入正则**必须能匹配** `await import('pkg')` 并捕获包名（行为，不是字面量） |
 * | ② | 必须保留两道去噪（注释行 / 占位说明符），否则文档里的示例会把门禁变成噪声 |
 * | ③ | `architectureGate.mjs` 同样认得 `import(`（两脚本口径一致，防一边修一边退） |
 * | ④ | 实跑：新规则不得误伤真树——`node scripts/check.mjs --strict` 在当前仓库必须 exit 0 |
 *
 * 判据④是**只读**的真实核验；「端口层动态导入被阻断」的负向核验不便进自动化（要向 `src/` 里
 * 临时写文件，而套件是**并行**的、检索类判据会索引 `src/`，瞬态文件会造成假红），
 * 故那条按人工核验登记在看板（命令与结果都写在案）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** 读仓库内文本文件。 */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * 抽出 `check.mjs` 里那条导入正则的**模式文本**。
 * @returns 正则模式文本（可直接喂给 `new RegExp`）。
 */
function importPatternOf(): string {
  const src = read('scripts/check.mjs');
  const m = /const re =\s*\n?\s*\/([\s\S]*?)\/g;/.exec(src);
  assert.ok(m !== null, '没能从 check.mjs 抽出导入正则（形状变了就同步本判据）');
  return m[1] ?? '';
}

test("① 导入正则必须匹配动态导入 await import('pkg') 并捕获包名", () => {
  const re = new RegExp(importPatternOf(), 'g');
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ["const m = await import('zod');", 'zod'],
    ["const { x } = await import('@scope/pkg/sub.js');", '@scope/pkg/sub.js'],
    ["import('sharp')", 'sharp'],
    ["import x from 'left-pad';", 'left-pad'],
    ["import 'side-effect-pkg';", 'side-effect-pkg'],
    ["const y = require('cjs-pkg');", 'cjs-pkg'],
  ];
  for (const [code, expected] of cases) {
    const found = [...code.matchAll(re)].map((mm) => mm[1]);
    assert.deepStrictEqual(found, [expected], `未按预期捕获：${code}`);
  }
  // 反向：`import.meta` 不是导入，不得被误捕
  assert.deepStrictEqual([...`const u = import.meta.url;`.matchAll(re)], []);
});

test('② 两道去噪必须在位（注释行 / 占位说明符）', () => {
  const src = read('scripts/check.mjs');
  assert.match(src, /function isCommentLine/, '缺注释行去噪（文档里的示例会被当成导入）');
  assert.match(
    src,
    /function looksLikePackageName/,
    "缺占位说明符去噪（`import('<pkg>')` 会被当成导入）",
  );
  assert.match(
    src,
    /if \(isCommentLine\(src, m\.index\)\) continue;/,
    '去噪函数定义了但没在 checkImports 里生效',
  );
  assert.match(src, /if \(!looksLikePackageName\(spec\)\) continue;/, '去噪函数定义了但没生效');
  // 深导入必须仍算「已导入」：否则「未使用的已装依赖」会误报（首版踩过）
  const src2 = `const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');`;
  const re = new RegExp(importPatternOf(), 'g');
  assert.deepStrictEqual(
    [...src2.matchAll(re)].map((mm) => mm[1]),
    ['@modelcontextprotocol/sdk/server/stdio.js'],
    '深导入（子路径）必须被捕获',
  );
});

test('③ architectureGate 与我同口径认得 import(', () => {
  assert.match(
    read('scripts/architectureGate.mjs'),
    /import\\s\*\\\(|import\s*\\\(/,
    'architectureGate 的导入正则不再匹配 import( ⇒ 两脚本口径分裂',
  );
});

test('④ 实跑：新规则不误伤真树（node scripts/check.mjs --strict 必须 exit 0）', () => {
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'check.mjs'), '--strict'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(out, /铁律自检通过/, `铁律未通过：${out.slice(0, 800)}`);
});
