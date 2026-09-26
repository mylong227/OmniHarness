// 旗标白名单守卫（.mjs 侧薄壳）：**未知 `--flag` 一律 fail-closed**，不再静默忽略。
//
// 纯逻辑在 `src/util/flagGuard.ts`（`FlagGuard`）——放 TS 里是为了进 `tests/unit` 的 CI 覆盖；
// 本文件只负责「读脚本源码 + 退出进程」这层与 Node/IO 相关的搬运。
//
// 动因（2026-09-26 实测事故）：`arg()` 对拼错的旗标只返回 undefined ⇒ 驼峰写法
// （`best-of-N` 用大写 N）没报错，把「产品口径 4 候选」静默跑成**单候选**，白花一次 pilot。
//
// 用法（在每个脚本解析完参数后立刻调用一次）：
//   import { assertKnownFlags } from './lib/flagGuard.mjs';
//   assertKnownFlags(import.meta.url);

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FlagGuard } from '../../dist/src/util/flagGuard.js';

/**
 * 从脚本源码里收集「被解析」的旗标集合。
 * @param {string} scriptPath 脚本绝对路径。
 * @returns {ReadonlySet<string>} 旗标集合。
 */
export function knownFlagsOf(scriptPath) {
  return FlagGuard.knownFlagsOf(readFileSync(scriptPath, 'utf8'));
}

/**
 * 断言命令行里没有未知旗标；有则打印可读报错并**退出进程**。
 * @param {string} importMetaUrl 调用方的 `import.meta.url`。
 * @returns {void} 无未知旗标时静默返回。
 */
export function assertKnownFlags(importMetaUrl) {
  const known = knownFlagsOf(fileURLToPath(importMetaUrl));
  const unknown = FlagGuard.unknownFlags(process.argv.slice(2), known);
  if (unknown.length === 0) return;
  console.error(FlagGuard.unknownFlagMessage(unknown, known));
  process.exit(2);
}
