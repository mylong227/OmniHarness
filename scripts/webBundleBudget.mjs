#!/usr/bin/env node
/**
 * Web 产物**体积预算**门禁（2026-10-18，W1）。
 *
 * ## 为什么需要它
 *
 * 仓库已有 `gateBudget.mjs` 管**门禁耗时**，但**首屏产物体积**没有任何预算：
 * 实测 2026-10-18 之前首屏 JS 是 1102 KB / gzip 373 KB——没有任何机制阻止下一个人
 * 再 `import` 一个大依赖。体积只会在 review 时被"看着还行"放过，然后一年后没人愿意动。
 *
 * ## 口径（都可复核）
 *
 *   · 只统计 `web/dist/assets/` 下的 `.js` / `.css`（Vite 产物）；
 *   · **首屏口径 = 入口 chunk**（`index-*.js` / `index-*.css`）。懒加载产生的异步 chunk
 *     （如 KaTeX 的 `katex-*.js`）**不计入预算**——它们不在首屏关键路径上，只单独打印；
 *     把这部分算进去会让"拆包"看起来像"没优化"，预算就失去意义；
 *   · **gzip 后的字节数**是预算口径（与 CI 传输口径一致）；原始字节同时打印，便于定位；
 *   · 预算写在 `scripts/webBundleBudget.json`（数据而非代码：收紧预算 = 改一个数字，
 *     不需要改脚本逻辑，diff 也一眼可见）。
 *
 * ## 用法
 *
 * ```bash
 * npm run web:build && npm run web:budget
 * node scripts/webBundleBudget.mjs --json    # 机器可读
 * ```
 *
 * 退出码：0 = 达标；1 = 超预算（打印"当前 / 预算 / 超出"三项）；2 = 产物缺失（忘了 build）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const ASSETS = join('web', 'dist', 'assets');
const CONFIG = JSON.parse(readFileSync(join('scripts', 'webBundleBudget.json'), 'utf8'));

if (!existsSync(ASSETS)) {
  process.stderr.write(`✗ 产物缺失：${ASSETS}（先跑 npm run web:build）\n`);
  process.exit(2);
}

/** 按扩展名汇总 gzip 体积；**入口**（index-*）与**异步块**分开记。 */
const totals = {
  js: { raw: 0, gzip: 0, files: [] },
  css: { raw: 0, gzip: 0, files: [] },
  async: { raw: 0, gzip: 0, files: [] },
};
for (const name of readdirSync(ASSETS)) {
  const isJs = name.endsWith('.js');
  const isCss = name.endsWith('.css');
  if (!isJs && !isCss) continue;
  const entryLike = /^index-/.test(name);
  const bucket = entryLike ? (isJs ? 'js' : 'css') : 'async';
  const buf = readFileSync(join(ASSETS, name));
  const gz = gzipSync(buf).length;
  totals[bucket].raw += buf.length;
  totals[bucket].gzip += gz;
  totals[bucket].files.push({ name, raw: buf.length, gzip: gz });
}

/** 数字人读：KB 保留一位小数。 */
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const rows = [];
let failed = false;
for (const kind of ['js', 'css', 'async']) {
  const budgetKb = CONFIG[`${kind}Kb`];
  const gotKb = totals[kind].gzip / 1024;
  const over = gotKb > budgetKb;
  failed = failed || over;
  rows.push({
    kind,
    files: totals[kind].files.length,
    rawKb: Number((totals[kind].raw / 1024).toFixed(1)),
    gzipKb: Number(gotKb.toFixed(1)),
    budgetKb,
    over,
  });
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ rows, async: totals.async, ok: !failed }, null, 2)}\n`);
} else {
  for (const r of rows) {
    const mark = r.over ? '✗' : '✓';
    process.stdout.write(
      `${mark} ${r.kind.toUpperCase().padEnd(3)} ${String(r.files).padStart(2)} 个文件 ｜ 原始 ${String(r.rawKb).padStart(7)} KB ｜ gzip ${String(r.gzipKb).padStart(6)} KB ｜ 预算 ${r.budgetKb} KB\n`,
    );
  }
  for (const kind of ['js', 'css']) {
    const biggest = totals[kind].files.sort((a, b) => b.gzip - a.gzip)[0];
    if (biggest !== undefined) {
      process.stdout.write(`  · ${kind} 最大件：${biggest.name}（gzip ${kb(biggest.gzip)}）\n`);
    }
  }
  // 异步块 **也进预算**（2026-10-18 起）：懒加载把字节从入口挪走，但用户第一次用公式/
  // 首次打开面板时仍要付这笔网络与解析成本。只 gate 入口 = 允许“把包越拆越大”。
  if (totals.async.files.length > 0) {
    process.stdout.write(
      `  · 异步块明细：${totals.async.files.map((f) => `${f.name} ${kb(f.gzip)}`).join('、')}\n`,
    );
  }
}
process.exit(failed ? 1 : 0);
