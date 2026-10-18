// 判据：样式表源码里**不得出现 U+FEFF（BOM）**——它会让紧随其后的那条规则被浏览器整条丢弃。
//
// ## 为什么值得单列（2026-10-18 实测）
//
// 折叠 `polish-*` / `refine-*` 时用了"按原样拼接 "，而其中若干文件**开头带 BOM**。
// 拼接后 BOM 落到了文件中间，esbuild 把它转义成 `\feff` 写进产物；浏览器的 CSS 解析器
// 在 `}` 与下一条选择器之间遇到它时，会把它当成非法 prelude 的开头，**整条规则（含它的
// 声明块）被消费掉**——不报错、不警告，表现是"某条规则神秘失效"。
//
// 本轮实例：legacy-a 里 `.composer` 的 `margin: 0 16px 16px` 因此从未生效，
// 而计算样式快照把它算进了"差异"，差点被误判成级联去重的回归。
// 清理方式是 `String.replace('\uFEFF','')`；这条判据防止它再被编辑器/拼接工具带回来。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';

const STYLE_DIR = new URL('../styles', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('样式表源码不得含 U+FEFF（BOM 落在文件中间会静默丢弃下一条规则）', () => {
  const offenders: string[] = [];
  for (const file of readdirSync(STYLE_DIR).filter((f) => f.endsWith('.css'))) {
    const text = readFileSync(join(STYLE_DIR, file), 'utf8');
    // 文件**开头**的 BOM 是合法的（编辑器常见，CSS 解析器会忽略），只查中间位置。
    const index = text.indexOf('\uFEFF');
    if (index > 0) {
      const line = text.slice(0, index).split('\n').length;
      offenders.push(`${file}:${line}`);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    '以下样式表在文件中间含 BOM（拼接工具/编辑器常见副作用）：用 replace("\\uFEFF","") 清掉后重跑：\n' +
      offenders.join('\n'),
  );
});
