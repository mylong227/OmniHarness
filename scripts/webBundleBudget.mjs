#!/usr/bin/env node
/**
 * Web 产物**体积预算**门禁（2026-10-18，W1；2026-10-28 随 antd 迁移重写口径）。
 *
 * ## 为什么需要它
 *
 * 仓库已有 `gateBudget.mjs` 管**门禁耗时**，但**首屏产物体积**没有任何预算：
 * 实测 2026-10-18 之前首屏 JS 是 1102 KB / gzip 373 KB——没有任何机制阻止下一个人
 * 再 `import` 一个大依赖。体积只会在 review 时被"看着还行"放过，然后一年后没人愿意动。
 *
 * ## 口径（2026-10-28 随 vendor 分块重写；数字来自 UI_LIBRARY_UPGRADE §0.5 实测）
 *
 *   · 只统计 `web/dist/assets/` 下的 `.js` / `.css`（Vite 产物）；
 *   · **首屏 = entry chunk（index-*.js）+ vendor 分块（vendor-*.js）**：vendor 分块（react 基座 /
 *     antd 基座）经 modulepreload 与入口同批加载，全在关键路径上——只 gate entry 会允许
 *     "把包越拆越大"。async chunk（懒加载面板 / katex）不在首屏，单独记；
 *   · **gzip 后的字节数**是预算口径（与 CI 传输口径一致）；原始字节同时打印，便于定位；
 *   · 预算写在 `scripts/webBundleBudget.json`（数据而非代码：收紧预算 = 改一个数字）：
 *       - firstLoadKb：entry + vendor 总量（W0 实测后定为 630，含 ~10% 余量）；
 *       - entryJsKb：entry 单独上限（应用码 + markdown-it/highlight，防应用码无节制膨胀）；
 *       - cssKb / asyncKb：不变口径（asyncKb 170 = 原 120 + antd 面板懒加载余量）。
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

/** 按扩展名与文件名汇总 gzip 体积；entry / vendor / async 分桶（2026-10-28 起 vendor 单列）。 */
const totals = {
  js: { raw: 0, gzip: 0, files: [] },
  vendor: { raw: 0, gzip: 0, files: [] },
  css: { raw: 0, gzip: 0, files: [] },
  async: { raw: 0, gzip: 0, files: [] },
};
for (const name of readdirSync(ASSETS)) {
  const isJs = name.endsWith('.js');
  const isCss = name.endsWith('.css');
  if (!isJs && !isCss) continue;
  const entryLike = /^index-/.test(name);
  const vendorLike = /^vendor-/.test(name);
  const bucket = entryLike ? (isJs ? 'js' : 'css') : vendorLike ? 'vendor' : 'async';
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
for (const kind of ['js', 'vendor', 'css', 'async']) {
  const budgetKb = CONFIG[`${kind === 'js' ? 'entryJs' : kind}Kb`];
  const gotKb = totals[kind].gzip / 1024;
  // vendor 桶在尚未分出 vendor 文件的构建里为 0：不硬性要求存在（存在性由边界判据管）。
  const over = budgetKb !== undefined && gotKb > budgetKb;
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
// 首屏合计 = entry + vendor（关键路径总量，真正的合并闸口径）。
const firstLoadGzip = totals.js.gzip + totals.vendor.gzip;
const firstLoadOver = firstLoadGzip / 1024 > CONFIG.firstLoadKb;
failed = failed || firstLoadOver;
rows.push({
  kind: 'firstload',
  files: totals.js.files.length + totals.vendor.files.length,
  rawKb: Number(((totals.js.raw + totals.vendor.raw) / 1024).toFixed(1)),
  gzipKb: Number((firstLoadGzip / 1024).toFixed(1)),
  budgetKb: CONFIG.firstLoadKb,
  over: firstLoadOver,
});

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ rows, async: totals.async, ok: !failed }, null, 2)}\n`);
} else {
  const label = {
    js: 'ENTRY',
    vendor: 'VENDOR',
    css: 'CSS',
    async: 'ASYNC',
    firstload: '首屏(ENTRY+VENDOR)',
  };
  for (const r of rows) {
    const mark = r.over ? '✗' : '✓';
    process.stdout.write(
      `${mark} ${String(label[r.kind] ?? r.kind).padEnd(18)} ${String(r.files).padStart(2)} 个文件 ｜ 原始 ${String(r.rawKb).padStart(7)} KB ｜ gzip ${String(r.gzipKb).padStart(6)} KB ｜ 预算 ${r.budgetKb} KB\n`,
    );
  }
  for (const kind of ['js', 'vendor', 'css']) {
    const biggest = totals[kind].files.sort((a, b) => b.gzip - a.gzip)[0];
    if (biggest !== undefined) {
      process.stdout.write(`  · ${kind} 最大件：${biggest.name}（gzip ${kb(biggest.gzip)}）\n`);
    }
  }
  if (totals.async.files.length > 0) {
    process.stdout.write(
      `  · 异步块明细：${totals.async.files.map((f) => `${f.name} ${kb(f.gzip)}`).join('、')}\n`,
    );
  }
}
process.exit(failed ? 1 : 0);
