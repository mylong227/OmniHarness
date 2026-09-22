#!/usr/bin/env node
/**
 * 构建产物清理（零依赖）。
 *
 * ## 为什么需要它
 *
 * `tsc` **只写不删**：源文件改名或删除后，旧产物会永久留在输出目录里。已实测两类后果——
 * ① `dist/tests/unit/*.test.js` 通配会继续执行**已删除的测试**（看着是绿的，跑的是幽灵用例）；
 * ② `package.json` 的 `files` 含 `dist/src` 与 `web`，陈旧模块会随发布进入 tarball。
 *
 * 故 `build` / `web:build` 在编译前先清理各自的输出目录，让「磁盘产物 ≡ 当前源码」恒成立。
 *
 * 用法：`node scripts/cleanDist.mjs dist web/dist`（无参数时默认只清 `dist`）。
 */
import { existsSync, rmSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : ['dist'];
const posix = (p) => p.split(sep).join('/');

for (const target of targets) {
  const abs = resolve(ROOT, target);
  const rel = relative(ROOT, abs);
  // 安全闸：只清理「仓库内 + 路径最后一段恰为 dist」的目录，避免空参或越界把仓库根删掉。
  if (rel === '' || rel.startsWith('..') || rel.split(sep).pop() !== 'dist') {
    console.error(`[cleanDist] 拒绝清理越界或非 dist 目标：${target}`);
    process.exit(1);
  }
  if (!existsSync(abs)) {
    console.log(`[cleanDist] 跳过（不存在）：${posix(rel)}`);
    continue;
  }
  rmSync(abs, { recursive: true, force: true });
  console.log(`[cleanDist] 已清理：${posix(rel)}`);
}
