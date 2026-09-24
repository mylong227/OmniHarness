#!/usr/bin/env node
/**
 * eval 脚本统一入口（零依赖）。
 *
 * ## 为什么需要它（审计 §3.5「eval 脚本未接入 npm script」的收口）
 *
 * `evals/` 下有几十个独立脚本，此前**没有统一入口**：想知道有哪些、怎么跑、要不要先构建，
 * 只能翻目录；而逐个写进 `package.json` 又会把「构建先决 / 参数透传 / 退出码转发」这套逻辑
 * 复制几十遍。故：本 runner 是**唯一实现**，`package.json` 里每个 `eval:<名字>` 都只是
 * `node scripts/runEval.mjs <名字>` 的一行别名。
 *
 * ## 用法
 *
 * ```bash
 * npm run eval:list                      # 列出全部可用 eval
 * npm run eval:run -- recall-precision   # 跑某一个（后续参数原样透传）
 * node scripts/runEval.mjs rerank-ab --gate
 * ```
 *
 * ## 构建先决（fail-closed 的「响亮失败」）
 *
 * 多数 eval 通过 `dist/` 引入本仓代码；`dist/src/index.js` 缺失时**直接报错并给出修复命令**，
 * 而不是让脚本在深处抛出 `Cannot find module`（那会让人误以为是脚本坏了）。
 */
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVALS_DIR = join(ROOT, 'evals');
const BUILD_ENTRY = join(ROOT, 'dist', 'src', 'index.js');

/**
 * 列出可用 eval 名（`evals/*.mjs`，排除 live/ 子目录——它有专用入口）。
 * @returns 升序排列的脚本名。
 */
function listEvals() {
  return readdirSync(EVALS_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => name.slice(0, -'.mjs'.length))
    .sort();
}

const [name, ...rest] = process.argv.slice(2);

if (name === undefined || name === '--list' || name === 'list') {
  console.log('可用 eval（npm run eval:run -- <名字> [参数...]）：');
  for (const item of listEvals()) console.log(`  ${item}`);
  process.exit(0);
}

const script = join(EVALS_DIR, `${name}.mjs`);
if (!existsSync(script)) {
  console.error(`✗ 未找到 eval "${name}"。可用：`);
  for (const item of listEvals()) console.error(`  ${item}`);
  process.exit(2);
}

if (!existsSync(BUILD_ENTRY)) {
  console.error('✗ 缺少构建产物 dist/src/index.js（多数 eval 经 dist 引入本仓代码）。');
  console.error('  请先执行：npm run build（或 npm run native:build && npm run build）');
  process.exit(2);
}

// stdio: inherit —— 让 eval 的输出/交互/退出码原样透传给用户（不吞输出、不改退出码）。
const result = spawnSync(process.execPath, [script, ...rest], { cwd: ROOT, stdio: 'inherit' });
process.exit(result.status ?? 1);
