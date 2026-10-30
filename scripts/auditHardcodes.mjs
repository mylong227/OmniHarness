#!/usr/bin/env node
/**
 * 硬编码清单（**报告型**；不阻断提交）。
 *
 * ## 定位（与门禁的分工）
 *
 * 本仓对「硬编码」的**阻断**是**逐类**做的：`tests/unit/endpointDefaults.test.ts`（地址）、
 * `tests/unit/runtimeLimits.test.ts`（各段运维旋钮）、`tests/unit/devAddressContract.test.ts`
 * （开发回路地址）——它们钉的是**具体文件 + 具体字面量**，变红时定位清楚。
 * 本脚本补的是**全局可见性**：把「还剩哪些、属于哪类、在哪一行」机器化列出来，
 * 免得「还有多少硬编码」只能靠人肉记忆（那正是前几轮反复重扫的根因）。
 *
 * 为什么**不**做成阻断门禁：`ops-literal` 一类里混着大量**协议/模型常量**
 *（`maxOutputTokens: 32_768`、推理档位 `minimal: 1024`），它们不该可配；
 * 用统一模式拦会让正常新增代码变红（假红比漏网更糟）。真正的阻断留给上面的逐类判据。
 *
 * ## 分类
 *
 * | 类别 | 识别 | 说明 |
 * | --- | --- | --- |
 * | `address` | `http(s)://…` 与 `127.0.0.1:端口` | 地址应由 `defaults/endpoints.json` / `devConfig` 提供 |
 * | `abs-path` | 引号内的 `C:\…`、`/Users/…`、`/home/…` | 绝对路径应经 `OmniHome` / 路径解析得到 |
 * | `ops-literal` | 超时/上限/间隔类标识符后跟 ≥1000 的数字字面量 | 运维旋钮应由 `defaults/limits.json` 提供 |
 * | `limit-env` | `LimitEnv.int('OMNI_X', <数字>)` | 已有 env 钩子但默认值内联（P7/P8/P9 后仅剩边界项） |
 *
 * ## 用法
 *
 * ```bash
 * node scripts/auditHardcodes.mjs              # 汇总 + 各类前 20 条
 * node scripts/auditHardcodes.mjs --json       # 机器可读
 * node scripts/auditHardcodes.mjs --category=ops-literal
 * node scripts/auditHardcodes.mjs --root=web/src
 * ```
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 各分类的识别规则（顺序即报告顺序）。 */
const CATEGORIES = Object.freeze({
  address: /https?:\/\/[^\s'"`]+|(?:127\.0\.0\.1|localhost):\d+/u,
  'abs-path': /['"][A-Za-z]:\\\\|['"]\/(?:Users|home)\//u,
  'ops-literal':
    /\b(?:timeout|ttl|interval|delay|retry|max|min|limit|size|bytes|days|hours|minutes|batch|page|capacity|threshold|quota|budget|concurrency|grace|idle)[A-Za-z]*\s*(?::[^=]+)?[=:]\s*(\d[\d_]{3,})\b/iu,
  'limit-env': /LimitEnv\.int\(\s*['"][A-Z0-9_]+['"]\s*,\s*\d/u,
});

/**
 * 递归收集目录下的 `.ts`（跳过 d.ts / node_modules / dist / .git）。
 * @param {string} dir 起始目录（绝对路径）。
 * @returns {string[]} 文件绝对路径。
 */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * 扫描一组文件，返回分类命中。
 *
 * 注释行（`//` / `*` / `/*` 开头的行）与空白行跳过——文档里提到地址是合法的。
 * @param {string} root 仓库根（绝对路径）。
 * @param {string[]} files 待扫文件（绝对路径）。
 * @returns {{ hits: Array<{file: string, line: number, category: string, text: string}>, scanned: number }}
 */
export function collectHardcodes(root, files) {
  const hits = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const text = line.trim();
      if (text === '' || text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) {
        return;
      }
      // 行内豁免：协议常量 / 静态方法里拿不到配置的边界项（见看板 §195）。
      if (text.includes('hardcode-exempt')) return;
      for (const [category, pattern] of Object.entries(CATEGORIES)) {
        if (pattern.test(line)) {
          hits.push({
            file: relative(root, file).split('\\').join('/'),
            line: index + 1,
            category,
            text: text.length > 120 ? `${text.slice(0, 117)}…` : text,
          });
        }
      }
    });
  }
  return { hits, scanned: files.length };
}

/**
 * 按分类汇总。
 * @param {Array<{category: string}>} hits 命中列表。
 * @returns {Record<string, number>} 分类 → 条数。
 */
export function summarize(hits) {
  const out = {};
  for (const category of Object.keys(CATEGORIES)) out[category] = 0;
  for (const hit of hits) out[hit.category] = (out[hit.category] ?? 0) + 1;
  return out;
}

/**
 * 入口。
 * @param {string[]} argv 命令行参数（不含 node 与脚本名）。
 * @returns {number} 退出码（报告型恒 0；参数错误 2）。
 */
export function main(argv) {
  const json = argv.includes('--json');
  const categoryArg = argv.find((a) => a.startsWith('--category='));
  const rootArg = argv.find((a) => a.startsWith('--root='));
  const root = resolve(
    process.cwd(),
    rootArg === undefined ? 'src' : rootArg.slice('--root='.length),
  );
  const files = walk(root);
  const { hits, scanned } = collectHardcodes(process.cwd(), files);
  const wanted = categoryArg === undefined ? undefined : categoryArg.slice('--category='.length);
  const filtered = wanted === undefined ? hits : hits.filter((h) => h.category === wanted);
  if (wanted !== undefined && !Object.hasOwn(CATEGORIES, wanted)) {
    process.stderr.write(`未知分类 '${wanted}'（可用：${Object.keys(CATEGORIES).join(' / ')}）\n`);
    return 2;
  }
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ scanned, root: relative(process.cwd(), root), summary: summarize(hits), hits: filtered }, null, 2)}\n`,
    );
    return 0;
  }
  const summary = summarize(hits);
  process.stdout.write(
    `扫描 ${String(scanned)} 个 .ts（${relative(process.cwd(), root) || '.'}）——` +
      Object.entries(summary)
        .map(([k, v]) => `${k} ${String(v)}`)
        .join(' ｜ ') +
      '\n',
  );
  let shown = 0;
  for (const hit of filtered) {
    if (shown >= 20) {
      process.stdout.write(`  …… 共 ${String(filtered.length)} 条，用 --json 看全量\n`);
      break;
    }
    process.stdout.write(`  [${hit.category}] ${hit.file}:${String(hit.line)}  ${hit.text}\n`);
    shown += 1;
  }
  return 0;
}

// CLI 入口（被 import 时不自执行——判据要直接调 collectHardcodes）。
if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  process.exit(main(process.argv.slice(2)));
}
