#!/usr/bin/env node
/**
 * 发布物零密钥门禁（零依赖）——把「个人凭据不得进版本库」从纪律变成机器兜底。
 *
 * ## 为什么需要它
 *
 * 2026-09-08 的 `31878a2`（re-init from working tree）曾把含真实 DeepSeek key 的
 * `omniharness.json` 带进 git 历史并推送远端，直至 2026-09-25 全量盘点才被发现，
 * 处置代价是全史重写 + 密钥轮换。凭据分层纪律已确立：真实密钥只放**用户级**
 * `~/.omniharness/omniharness.json`（仓库树之外），本门禁确保任何形似真实密钥的
 * 内容一旦进入暂存区/版本库即提交中止——个人数据从此在机制上不可能抵达发布物。
 *
 * ## 口径
 *
 * - pre-commit 以 `--staged` 扫**暂存内容**（要提交什么就扫什么）；手动跑不带参数扫 HEAD；
 * - 只报「形似真实密钥」的高置信模式（sk- 长串 / AWS / GitHub / Slack），避免示例值假阳；
 * - 行内含 `omniharness:fake-secret` 标记的行豁免（测试夹具登记口）；
 * - 命中输出只给 文件:行号 + 模式名，**不回显密钥内容**（避免门禁自身成为泄露面）。
 *
 * 用法：
 *   node scripts/checkSecrets.mjs            # 扫 HEAD（手动体检）
 *   node scripts/checkSecrets.mjs --staged   # 扫暂存内容（pre-commit 调用）
 */
import { execFileSync } from 'node:child_process';

const PATTERNS = [
  { re: /sk-[A-Za-z0-9]{16,}/, name: 'sk- 风格模型密钥（DeepSeek/OpenAI 兼容）' },
  { re: /AKIA[0-9A-Z]{16}/, name: 'AWS AccessKeyId' },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/, name: 'GitHub token' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/, name: 'Slack token' },
];

/** 行内豁免标记：测试夹具里的假密钥在行尾加此注释即可通过。 */
const ALLOW_MARKER = 'omniharness:fake-secret';

const staged = process.argv.includes('--staged');
const gitArgs = staged ? ['grep', '--cached', '-InI', '-E'] : ['grep', '-InI', '-E'];

const hits = [];
for (const { re, name } of PATTERNS) {
  let out = '';
  try {
    out = execFileSync('git', [...gitArgs, re.source, ...(staged ? [] : ['HEAD'])], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // git grep 无命中时退出码 1：属预期路径，静默
    if (err.status !== 1) throw err;
  }
  for (const line of out.split('\n')) {
    if (line.trim() === '' || line.includes(ALLOW_MARKER)) continue;
    hits.push({ line, name });
  }
}

if (hits.length === 0) {
  console.log(
    `[checkSecrets] ✓ 零密钥（扫描${staged ? '暂存内容' : 'HEAD'}，4 类高置信模式，豁免标记 ${ALLOW_MARKER}）`,
  );
  process.exit(0);
}

console.error(`[checkSecrets] ✗ 检测到 ${hits.length} 处疑似真实密钥：`);
for (const h of hits) {
  console.error(`  ${h.line}    ← ${h.name}`);
}
console.error('个人凭据只允许放在用户级 ~/.omniharness/omniharness.json（仓库树之外）。');
console.error('若为测试假密钥，请在该行加豁免标记注释：omniharness:fake-secret');
process.exit(1);
