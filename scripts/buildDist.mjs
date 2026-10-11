#!/usr/bin/env node
/**
 * 原子化产物构建：**先建到暂存目录，再换入 `dist`**——绝不"先删 dist 再编译"。
 *
 * ## 为什么改（2026-10-11 本机实测的真实故障）
 *
 * 旧顺序是 `cleanDist dist && tsc && copyAssets`。本机有一个从本仓库 `dist/` 启动的
 * `serve` 在跑时，`cleanDist` 的 `rmSync` 会在**删到一半**（`dist/src/adapters`）抛
 * `ENOTEMPTY`，5 次退避重试后仍失败 ⇒ 留下一个**半删的 dist**：
 * `--version` 还能跑，`doctor` 直接报 `Cannot find module dist/src/core/agent.js`；
 * 而 **tsc 从未开始**（`&&` 短路）。也就是说：一次构建失败把工作树弄成了"比构建前更糟"的状态。
 *
 * ## 新顺序
 *
 * 1. `tsc -p tsconfig.json --outDir dist.next`（+ 伴生资源镜像进 `dist.next`）；
 * 2. **换入**：优先 `rename(dist → dist.old)` + `rename(dist.next → dist)`（真原子，Windows 上
 *    被占用的目录会失败）；失败即**回滚**并退化为"逐文件覆盖 + 清理陈旧"（不删整个 dist）；
 * 3. 删 `dist.old`（尽力而为：被占用则如实报告残留，不影响本次构建的可用性）；
 * 4. 删 `dist.next`。
 *
 * ## 诚实边界
 *
 * - 覆盖同步（退化路径）**不是**原子：正在跑测试的进程可能读到半新半旧的 dist。真原子的前提是
 *   "没有进程占用 dist"——被占用时不存在既原子又成功的做法（Windows 语义）。
 * - 陈旧文件清理失败（被占用）会**如实列出并让本脚本以 1 退出**：因为"tsc 只写不删"会让旧产物
 *   长期留在 dist 里（`dist/tests/unit/*.test.js` 通配会跑**已删除的幽灵用例**，看着绿其实跑的是旧代码）。
 *   要消掉它：停掉占用 dist 的进程（如 `omniharness serve`）后重跑，或设 `OMNI_ALLOW_STALE_DIST=1`
 *   显式接受（该环境变量只跳过"退出码"，不跳过警告）。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'dist');
const STAGING = join(ROOT, 'dist.next');
const BACKUP = join(ROOT, 'dist.old');
const ALLOW_STALE = process.env['OMNI_ALLOW_STALE_DIST'] === '1';

/** 逐文件收集（仓库相对 staging 的路径），跳过草稿/备份后缀。 */
function collect(dir, base = dir, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(abs, base, out);
      continue;
    }
    out.set(relative(base, abs).split(sep).join('/'), abs);
  }
  return out;
}

/** 尽力删除（失败返回错误码，不抛）。 */
function tryRemove(abs) {
  try {
    rmSync(abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return undefined;
  } catch (error) {
    return error?.code ?? String(error);
  }
}

/** 跑一步子命令，失败即清理暂存并退出（绝不触碰 dist；保留子进程输出便于定位）。 */
function run(label, file, args) {
  process.stdout.write(`[build] ${label} ...\n`);
  const result = spawnSync(file, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    tryRemove(STAGING);
    process.stderr.write(
      `[build] ✗ ${label} 失败（退出码 ${String(result.status)}）——` +
        '**dist 未被触碰**（旧实现此处已把 dist 删到一半）\n',
    );
    process.exit(result.status ?? 1);
  }
}

// ---- 1. 建到暂存目录 ----
tryRemove(STAGING);
const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
run('tsc → dist.next', process.execPath, [tsc, '-p', 'tsconfig.json', '--outDir', 'dist.next']);
run('伴生资源 → dist.next', process.execPath, [
  join(ROOT, 'scripts', 'copyAssets.mjs'),
  'dist.next',
]);

// ---- 2. 换入（优先原子换名，失败回滚后退化为覆盖同步） ----
const hadTarget = existsSync(TARGET);
let swapped = false;
try {
  tryRemove(BACKUP);
  if (hadTarget) renameSync(TARGET, BACKUP);
  renameSync(STAGING, TARGET);
  swapped = true;
  process.stdout.write('[build] ✓ 已原子换入 dist\n');
} catch (error) {
  // 回滚：把旧 dist 放回去（若已被移走），保证"构建失败不改变现状"
  if (existsSync(BACKUP) && !existsSync(TARGET)) {
    try {
      renameSync(BACKUP, TARGET);
    } catch {
      process.stderr.write('[build] ⚠ 回滚失败：dist.old 未能放回 dist，请手工处理\n');
    }
  }
  process.stdout.write(
    `[build] 目标被占用（${error?.code ?? String(error)}）⇒ 退化为逐文件覆盖同步（非原子）\n`,
  );
}

if (!swapped) {
  if (!existsSync(STAGING)) {
    process.stderr.write('[build] ✗ 暂存目录缺失，无法同步\n');
    process.exit(1);
  }
  const produced = collect(STAGING);
  for (const [rel, abs] of produced) {
    const dest = join(TARGET, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
  }
  // 陈旧清理：dist 里有、本次没产出的文件（旧语义里 cleanDist 会整树删掉它们）
  const stale = [];
  if (existsSync(TARGET)) {
    for (const [rel, abs] of collect(TARGET)) {
      if (!produced.has(rel)) stale.push({ rel, abs });
    }
  }
  const failed = [];
  for (const { rel, abs } of stale) {
    const code = tryRemove(abs);
    if (code !== undefined) failed.push(`${rel}（${code}）`);
  }
  process.stdout.write(
    `[build] 覆盖同步完成：写入 ${String(produced.size)} 个文件，清理陈旧 ${String(stale.length - failed.length)}/${String(stale.length)}\n`,
  );
  if (failed.length > 0) {
    process.stderr.write(
      `[build] ⚠ ${String(failed.length)} 个陈旧产物**未能删除**（被占用）：\n\n`,
    );
    for (const row of failed.slice(0, 20)) process.stderr.write(`    ${row}\n`);
    if (failed.length > 20) process.stderr.write(`    …共 ${String(failed.length)} 个\n`);
    process.stderr.write(
      '[build] 危害：`dist/tests/unit/*.test.js` 通配会跑**已删除的幽灵用例**（看着绿，跑的是旧代码）。\n' +
        '[build] 处置：停掉占用 dist 的进程（例如 `omniharness serve`）后重跑；' +
        '确要接受则设 OMNI_ALLOW_STALE_DIST=1。\n',
    );
    if (!ALLOW_STALE) {
      tryRemove(STAGING);
      process.exit(1);
    }
  }
  tryRemove(STAGING);
}

// ---- 3. 清理备份（尽力而为：被占用则如实报告） ----
if (existsSync(BACKUP)) {
  const code = tryRemove(BACKUP);
  if (code === undefined) {
    process.stdout.write('[build] ✓ 已清理上一版产物 dist.old\n');
  } else {
    process.stderr.write(
      `[build] ⚠ dist.old 未能删除（${code}）——它只是上一版副本，不影响本次构建；` +
        '停掉占用进程后重跑本脚本即会清掉。\n',
    );
  }
}
if (existsSync(STAGING)) tryRemove(STAGING);
if (!existsSync(join(TARGET, 'src'))) {
  process.stderr.write('[build] ✗ dist/src 不存在 ⇒ 本次构建未产出可用产物\n');
  process.exit(1);
}
if (statSync(join(TARGET, 'src')).isDirectory()) {
  process.stdout.write('[build] ✓ dist 已就绪\n');
}
