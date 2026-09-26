// 旗标白名单守卫：**未知 `--flag` 一律 fail-closed**，不再静默忽略。
//
// 动因（2026-09-26 实测踩中，代价是一次真实的 pilot 花费）：`swebench_predict.mjs` 用
// `arg(name)` 取值，而 `arg` 对**拼错的旗标**只是返回 undefined ⇒ 协议被静默改掉：
// 我写成 `--best-of-N 4`（驼峰），脚本没报错，跑成了 **单候选**（日志里 `best-of-N=1`），
// 与「产品口径 = 4 候选 + 自纠环」完全不符，且只有去读日志首行才发现。
// 本仓已有一条同族纪律（接线门禁：CLI 旗标不得只解析不使用）；这里是它的镜像问题——
// **不存在的旗标不得被静默接受**。
//
// 设计取舍：白名单由**读取脚本自身源码里真正被解析的旗标**生成，而不是手抄一份。
// 理由：手抄清单会随脚本演进漂移，而漂移的方向若是「漏抄」，就会拒绝合法用法（更糟）。
//
// 只认三种解析写法（本仓两个 benchmark 脚本的实际用法，已逐一核对）：
//   `arg('--x')`、`process.argv.includes('--x')`、`process.argv.indexOf('--x')`。
// ⚠️ 新增另一种解析写法时必须把它加进 {@link FLAG_PARSE}，否则该旗标会被误判为未知而**大声报错**
//    （方向安全：错在拒绝，不会静默放行）。
// ⚠️ 注释里**不要写错的旗标字面量**：白名单来自源码，写错就等于放行它。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 匹配「被真正解析」的旗标字面量（三种写法，见文件头）。 */
const FLAG_PARSE = /(?:arg|includes|indexOf)\(\s*'(--[a-z0-9][a-z0-9-]*)'/g;

/**
 * 从脚本源码里收集「被解析」的旗标集合。
 * @param {string} scriptPath 脚本绝对路径。
 * @returns {Set<string>} 旗标集合；若一个都没扫到则抛错（说明解析写法变了，不能静默放行一切）。
 */
export function knownFlagsOf(scriptPath) {
  const src = readFileSync(scriptPath, 'utf8');
  const found = new Set([...src.matchAll(FLAG_PARSE)].map((m) => m[1]));
  if (found.size === 0) {
    throw new Error(
      `旗标守卫无法从 ${scriptPath} 扫到任何被解析的旗标——解析写法可能已变（见 flagGuard 文件头）。`,
    );
  }
  return found;
}

/**
 * 断言命令行里没有未知旗标；有则打印可读报错并**退出进程**。
 * @param {string} importMetaUrl 调用方的 `import.meta.url`。
 * @returns {void} 无未知旗标时静默返回。
 */
export function assertKnownFlags(importMetaUrl) {
  const self = fileURLToPath(importMetaUrl);
  const known = knownFlagsOf(self);
  const unknown = [];
  for (const token of process.argv.slice(2)) {
    if (!token.startsWith('--')) continue;
    const name = token.split('=')[0];
    if (!known.has(name)) unknown.push(name);
  }
  if (unknown.length === 0) return;
  const hint = (name) => {
    const lower = name.toLowerCase();
    const near = [...known].filter((k) => k.toLowerCase() === lower);
    return near.length > 0 ? `（是否想写 ${near.join(' / ')}？大小写敏感）` : '';
  };
  console.error(
    `❌ 未知旗标：${unknown.map((u) => `${u}${hint(u)}`).join('、')}\n` +
      `   本脚本对未知旗标**不再静默忽略**——它曾把「产品口径 4 候选」静默跑成「单候选」。\n` +
      `   已支持：${[...known].sort().join(' ')}`,
  );
  process.exit(2);
}
