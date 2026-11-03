#!/usr/bin/env node
/**
 * audit 瘦 bin 的单文件打包器（2026-11-03 P1「一条命令」T1.2）。
 *
 * 产物：`dist/bin/audit.mjs`——esbuild 单文件 ESM bundle（platform=node，target=node22，
 * minify），`package.json` 的 `bin.audit` 指向它；`files` 含 `dist/bin`，npm 包因此自带
 * 一条不依赖完整 CLI 的出证命令。
 *
 * ## 体积判据（fail-closed）
 *
 * 产物 ≤ 300 KB（方案 T1.3）。这条线存在的意义：瘦入口的价值就是"只打 audit 世界"——
 * 一旦有人给 `src/apps/cli/auditBin.ts` 加了 execCli / cliBuildConfig 这类装配层 import，
 * bundle 会瞬间涨到 MB 级，这里直接红，而不是等用户抱怨 npx 变慢。
 *
 * ## 用法
 *
 *   node scripts/buildAuditBin.mjs     # 构建 + 体积判据（npm run build:audit-bin）
 *
 * esbuild 是 devDependency（只影响构建，不进产物——产物零第三方依赖，与 audit 应用口径一致）。
 */
import { existsSync, statSync } from 'node:fs';
import { build } from 'esbuild';

const OUT_FILE = 'dist/bin/audit.mjs';
/** 体积上限（字节）。 */
const MAX_BYTES = 300 * 1024;

await build({
  entryPoints: ['src/apps/cli/auditBin.ts'],
  outfile: OUT_FILE,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
});

if (!existsSync(OUT_FILE)) {
  console.error(`✗ esbuild 报告成功但产物缺失：${OUT_FILE}`);
  process.exit(1);
}
const size = statSync(OUT_FILE).size;
if (size > MAX_BYTES) {
  console.error(
    `✗ audit bin 体积 ${String(size)} 字节，超过 ${String(MAX_BYTES)} 字节判据。` +
      '多半是瘦入口引了装配层模块（execCli / cliBuildConfig / cliDataCmds…）——' +
      '把依赖瘦回去，而不是放宽这条线（见 src/apps/cli/auditBin.ts 头注）。',
  );
  process.exit(1);
}
console.log(`[auditBin] ${OUT_FILE} ${String(size)} 字节 ≤ ${String(MAX_BYTES)} ✓`);
