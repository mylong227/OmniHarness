#!/usr/bin/env node
/**
 * 提交门禁的**单一实现**（node 版，零依赖）——`scripts/git-hooks/pre-commit` 只是它的一层薄包装。
 *
 * ## 为什么要有这个文件（2026-09-25 实测事故）
 *
 * 门禁此前**只**活在 `scripts/git-hooks/pre-commit` 这个 sh 脚本里。后果有两条，都真实发生过：
 *  1. **受限环境下门禁彻底不可跑**：git 在 Windows 上必须经 `sh.exe` 起钩子，而受限沙箱会拒绝
 *     cygwin 的共享内存创建（`sh.exe: *** fatal error - CreateFileMapping ..., Win32 error 5`）⇒
 *     钩子连第一行都执行不到，提交**静默绕过全部门禁**（当天两笔提交就是这样进去的，靠事后手工补跑才补回）。
 *  2. **两处漂移**：CI 的 gate job 与钩子各写一份门禁清单，历史上已出现「钩子用 `npm run`、CI 用 `node`」
 *     这类分叉（`docs/UPGRADE_BOARD_2026-09-12.md` §pre-commit 适配记过一次，后来又漂回去）。
 *
 * 现在：判定逻辑只此一份，钩子与人工都调它——
 *  - 钩子：`scripts/git-hooks/pre-commit` → `node scripts/runGates.mjs --hook`
 *  - 人工（受限环境照跑）：`node scripts/runGates.mjs --hook` 或 `--only=iron-law,eslint`
 *
 * ## 用法
 *
 * ```bash
 * node scripts/runGates.mjs --hook               # 钩子模式：门禁 + 格式化暂存文件并重新 git add
 * node scripts/runGates.mjs --staged             # 只跑门禁（不格式化）
 * node scripts/runGates.mjs --list               # 列出全部门禁 id
 * node scripts/runGates.mjs --only=iron-law,eslint
 * node scripts/runGates.mjs --skip=secrets       # 例：环境屏蔽了 piped-stdio 子进程时跳过密钥门禁
 * ```
 *
 * `--skip` 是**显式出口**而非静默降级：跳过会打印醒目告警，且 CI 里从不跳过（CI 跑 `npm run check` 等原始命令）。
 *
 * ## 诚实边界
 *
 * - 本脚本用 `spawnSync(..., { stdio: 'inherit' })` 起子进程：受限沙箱**允许** inherit，但被它拒绝的是
 *   **子进程自己**再用管道起孙进程（例：`checkSecrets.mjs` 内部 `execFileSync('git', ...)`）——那种情况
 *   会在该关报 `EPERM`，请按上文 `--skip` 显式跳过并在放宽环境里补跑，不要改判定。
 * - 本脚本不读暂存内容做判断（除 prettier/git add）：语义判定全在各门禁脚本里，避免第二份真相。
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 仓库内 eslint 入口（零依赖：只用本仓 node_modules）。 */
const ESLINT_BIN = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
/** 仓库内 prettier 入口。 */
const PRETTIER_BIN = join(ROOT, 'node_modules', 'prettier', 'bin', 'prettier.cjs');

/**
 * 门禁清单（顺序即执行顺序；与历史 pre-commit 逐条对应）。
 * 每项：`id` 稳定标识、`label` 打印文案、`argv` node 参数数组、`fail` 失败时的可执行提示。
 */
const GATES = [
  {
    id: 'node-engine',
    label: 'Node 引擎门禁（engines.node 下限，fail-closed）',
    argv: ['scripts/checkNodeEngine.mjs'],
    fail: 'Node 版本不满足 engines.node，提交中止。请切换/安装符合要求的 Node（见 .nvmrc）。',
  },
  {
    id: 'iron-law',
    label: '铁律自检（--strict）',
    argv: ['scripts/check.mjs', '--strict'],
    fail: 'check.mjs 铁律校验未通过，提交中止。',
  },
  {
    id: 'maturity',
    label: '成熟度门禁（L2/L3 须有测试证据）',
    argv: ['scripts/auditStandards.mjs', '--maturity'],
    fail: '成熟度门禁未通过（L2/L3 须有 @maturityEvidence 指向真实测试），提交中止。',
  },
  {
    id: 'standard-delta',
    label: '编码标准增量门禁（禁止本次提交新增违规）',
    argv: ['scripts/auditStandards.mjs', '--delta'],
    fail: '检测到本次提交新增了编码标准违规，提交中止。',
  },
  {
    id: 'arch',
    label: '架构门禁（core↔adapters 冻结白名单，新增即红）',
    argv: ['scripts/architectureGate.mjs'],
    fail: '检测到新增架构违规（core↔adapters 不在白名单内或 ports 纯度受损），提交中止。',
  },
  {
    id: 'wiring',
    label: '接线完整性门禁（声明→装配→运行时→消费，断链即红）',
    argv: ['scripts/auditConfigWiring.mjs'],
    fail: '检测到未接线字段（本仓最高频缺陷形态「声明未接线」），提交中止。',
  },
  {
    id: 'doc-links',
    label: '文档死链门禁（链接目标指向不存在文件即红；存量已冻结）',
    argv: ['scripts/docLinkCheck.mjs'],
    fail: '文档新增死链（指向不存在的文件），提交中止。',
  },
  {
    id: 'secrets',
    label: '发布物零密钥门禁（个人凭据不得进版本库）',
    argv: ['scripts/checkSecrets.mjs', '--staged'],
    fail:
      '暂存内容含疑似真实密钥（个人凭据只放用户级 ~/.omniharness/omniharness.json；' +
      '测试假密钥加行内标记 omniharness:fake-secret），提交中止。',
  },
  {
    id: 'eslint',
    label: 'ESLint（零告警：--max-warnings=0，warn 亦阻断）',
    argv: [ESLINT_BIN, '.', '--max-warnings=0'],
    fail: 'ESLint 存在 error 或 warning，提交中止（告警预算已归零：静态告警曾编码真实断链）。',
  },
];

/**
 * 解析 `--key=value` 形态参数。
 * @param name 参数名（不含 `--`）。
 * @returns 值；未提供返回 undefined。
 */
function flagValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}

/**
 * 解析逗号分隔的 id 列表参数。
 * @param name 参数名（不含 `--`）。
 * @returns id 集合；未提供返回 undefined。
 */
function idSet(name) {
  const raw = flagValue(name);
  if (raw === undefined) return undefined;
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * 取暂存文件里需要格式化的那些（源码/配置/文档），供 prettier 增量格式化。
 * @returns 相对仓库根的路径数组（无暂存或非 git 环境返回空数组）。
 */
function stagedFormattable() {
  const r = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /\.(ts|js|mjs|cjs|json|md)$/.test(s));
}

/**
 * 跑一条门禁。
 * @param gate 门禁定义。
 * @returns 退出码（0 = 通过）。
 */
function runGate(gate) {
  const args = gate.argv.map((a) => (a.startsWith('scripts/') ? join(ROOT, a) : a));
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  return r.status ?? 1;
}

const hookMode = process.argv.includes('--hook');
const stagedMode = hookMode || process.argv.includes('--staged');
const skip = idSet('skip') ?? new Set();
const only = idSet('only');

if (process.argv.includes('--list')) {
  for (const g of GATES) console.log(`  ${g.id.padEnd(16)} ${g.label}`);
  process.exit(0);
}

const selected = GATES.filter((g) => (only === undefined ? true : only.has(g.id)));
const unknown = [...(only ?? [])].filter((id) => !GATES.some((g) => g.id === id));
if (unknown.length > 0) {
  console.error(`✗ 未知门禁 id：${unknown.join(', ')}（用 --list 看全部）`);
  process.exit(2);
}
const prefix = hookMode ? 'pre-commit' : 'gates';
let failed = 0;
for (const gate of selected) {
  if (skip.has(gate.id)) {
    console.error(
      `[${prefix}] ⚠️ 已按 --skip=${gate.id} 跳过「${gate.label}」——须在放宽环境补跑。`,
    );
    continue;
  }
  console.log(`[${prefix}] ${gate.label}...`);
  if (runGate(gate) !== 0) {
    console.error(`[${prefix}] ✗ ${gate.fail}`);
    failed += 1;
    break;
  }
}

// 仅格式化**已暂存**文件（增量，不触碰历史文件），随后重新暂存——与历史钩子行为逐字一致。
if (failed === 0 && hookMode) {
  const files = stagedFormattable();
  if (files.length > 0) {
    console.log(`[${prefix}] Prettier 格式化已暂存文件...`);
    for (const bin of [PRETTIER_BIN]) {
      if (!existsSync(bin)) {
        console.error(`[${prefix}] ✗ 缺少 ${bin}（请先 npm install）`);
        process.exit(1);
      }
      const r = spawnSync(process.execPath, [bin, '--write', ...files], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);
    }
    const add = spawnSync('git', ['add', ...files], { cwd: ROOT, stdio: 'inherit' });
    if ((add.status ?? 1) !== 0) process.exit(add.status ?? 1);
  }
}

if (failed > 0) process.exit(1);
if (stagedMode || hookMode || only !== undefined) console.log(`[${prefix}] ✓ 门禁通过`);
process.exit(0);
