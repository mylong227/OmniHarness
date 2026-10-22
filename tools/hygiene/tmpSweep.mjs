#!/usr/bin/env node
/**
 * 临时目录清扫（`npm run tmp:sweep`）。
 *
 * 只清 `os.tmpdir()` 下本仓前缀且超过年龄阈值的条目；默认 dry-run 之外需显式 `--apply`。
 * 这是**运维入口**，不是每次启动都自动删——避免把另一个正在跑的进程的临时目录清掉。
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE = join(ROOT, 'dist', 'src', 'util', 'tmpSweep.js');

/** 解析 `--key value` 参数。 */
function parseArgs(argv) {
  const out = { apply: false, olderThanHours: 24, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} 需要取值`);
      i += 1;
      return next;
    };
    if (arg === '--apply') out.apply = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--older-than-hours') out.olderThanHours = Number(value());
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!Number.isFinite(out.olderThanHours) || out.olderThanHours < 0) {
    throw new Error('--older-than-hours 必须是非负数');
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { TmpSweep } = await import(pathToFileURL(MODULE).href);
  const report = TmpSweep.run({
    olderThanMs: args.olderThanHours * 60 * 60 * 1000,
    dryRun: !args.apply,
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `tmp sweep: scanned=${report.scanned} matched=${report.matched.length} removed=${report.removed} dryRun=${report.dryRun}`,
    );
    for (const path of report.matched)
      console.log(`  ${report.dryRun ? 'would remove' : 'matched'} ${path}`);
    for (const error of report.errors) console.log(`  error: ${error}`);
  }
  if (report.errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
