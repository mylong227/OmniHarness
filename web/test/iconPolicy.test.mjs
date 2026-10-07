// 「交互控件上的图形一律走自研图标集，不得用 emoji」的机械判据。
//
// ## 为什么需要门禁而不是靠人记
//
// 2026-10-07 那轮把全站 100+ 处 emoji 当图标换成了 `web/src/ui/models/Icon.ts` 的线性图标集
// （emoji 的字形随系统字体变、尺寸不受控、不跟随 currentColor、彩色字形破坏单色层级）。
// 但"换一遍"不等于"以后不会再出现"——只要有人顺手写 `{cond ? '✅' : '❌'}`，规则就回退了，
// 而代码评审靠不住（emoji 在 diff 里极不显眼）。故把口径写成可执行判据。
//
// ## 口径（与 docs/DESIGN_SYSTEM.md §5 一致）
//
// · **禁止**：emoji / 彩色符号出现在**界面文案**里（它们在那里是"图标"）。
// · **允许**：正文里的语义符号 —— `✓ ✗ → ⇒ ▸ ▾ × ↑ ↓ ↻ ↩` 等，它们是**文本**的一部分
//   （进度、方向、状态结论），不是可交互控件的图形。这条界线不靠感觉：下面的 EXEMPT 逐项列出。
// · **允许**：注释与文档里的符号（`//` 与 `/* */` 内的内容不参与判定）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UI_DIR = new URL('../src/ui', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * emoji / 符号区段（够用即可，不追求覆盖 Unicode 全表）：
 * 杂项符号与装饰符（2600–27BF，含 ✅❌⚠✨🎯…）、箭头补充（2B00–2BFF）、
 * 变体选择符（FE0F，emoji 呈现专用）、以及补充平面里的 emoji 块（1F300–1FAFF）。
 */
const EMOJI = /[\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u{1F300}-\u{1FAFF}]/u;

/** 允许的语义符号（正文文本用；**不是**图标）。 */
const ALLOWED = new Set(['✓', '✗', '↻', '↩', '→', '⇒', '▸', '▾', '×', '↑', '↓', '⇄', '⧉', '★', '☆', '⚠']);

/**
 * 递归列出目录下的 .ts/.tsx（不含 .d.ts）。
 * @param dir 目录
 * @returns 文件绝对路径数组
 */
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * 剥掉注释，只留代码（避免把注释里的 emoji 当违规——注释不属于界面文案）。
 * @param src 源码
 * @returns 去注释后的源码
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('UI 源码里不得用 emoji 当图标（只允许列出的语义符号）', () => {
  const violations = [];
  for (const file of sourceFiles(UI_DIR)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    const lines = code.split('\n');
    lines.forEach((line, i) => {
      for (const ch of line) {
        if (!EMOJI.test(ch)) continue;
        if (ALLOWED.has(ch)) continue;
        violations.push(
          `${file.slice(UI_DIR.length + 1)}:${String(i + 1)} 出现 ${JSON.stringify(ch)} —— ` +
            '交互控件上的图形请用 models/Icon.ts 的 icon()；正文语义符号请加进 ALLOWED 并说明理由',
        );
      }
    });
  }
  assert.deepStrictEqual(violations, [], violations.join('\n'));
});

test('图标集是唯一出处：icon() 只接受 IconName，且 IconName 与 SHAPES 键集合一致', async () => {
  // 契约"拼错图标名 = 编译期错误"的前提是：类型联合与运行时形状表**同源**。
  // 若有人加了一个 IconName 却忘了加几何（或反之），类型层不会报错，运行时 icon() 会拿到 undefined
  // ⇒ 渲染出一个空 svg（正是本轮修过的"图标看起来像空方块"的同类故障）。这条把它挡在提交前。
  const src = readFileSync(join(UI_DIR, 'models', 'Icon.ts'), 'utf8');
  const union = /export type IconName =([\s\S]*?);/.exec(src);
  assert.ok(union !== null, '未找到 IconName 联合类型');
  const names = [...union[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();
  assert.ok(names.length > 30, `IconName 数量异常偏少（${String(names.length)}），解析可能失效`);
  const shapes = /const SHAPES:[\s\S]*?= \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(shapes !== null, '未找到 SHAPES 几何表');
  const keys = [...shapes[1].matchAll(/^\s{2}(?:'([a-z-]+)'|([a-z-]+)):/gm)]
    .map((m) => m[1] ?? m[2])
    .sort();
  assert.deepStrictEqual(
    keys.filter((k) => !names.includes(k)),
    [],
    'SHAPES 里有 IconName 未声明的键（icon() 会被误用为任意字符串）',
  );
  assert.deepStrictEqual(
    names.filter((n) => !keys.includes(n)),
    [],
    'IconName 里有 SHAPES 未定义几何的名字（运行时渲染空 svg）',
  );
});
