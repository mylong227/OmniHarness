#!/usr/bin/env node
// OmniHarness · Node 引擎门禁（零依赖）。
//
// 目的：把「本机 Node 统一 22」从「package.json 里声明、npm engine-strict 默认关所以形同虚设」
// 变成**机器强制**——提交前置 (pre-commit) 与本地自检都会按 engines.node 下限 fail-closed 报错。
//
// 支持约束语法（够用且 fail-closed：不认识的语法一律判违规，防止被悄悄放行）：
//   ">=22.14.0"    >= 下限（主用）
//   "^22.14.0"     >= 下限 且 < 下一主版本
//   "22.14.0"      裸版本，按 >= 处理
//
// 退出码：满足 0；不满足 1；用法/解析错误 2。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SELF = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SELF, '..');

/** 解析 "v22.22.2" -> [22,22,2]；非法抛错。 */
function parseVersion(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/.exec(String(raw).trim());
  if (!m) throw new Error('无法解析版本号: ' + JSON.stringify(raw));
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 解析 engines.node 约束 -> { min:[..], maxMajor?:number }。 */
function parseConstraint(spec) {
  const s = String(spec).trim();
  if (/^\^/.test(s)) {
    const v = parseVersion(s.slice(1));
    return { min: v, maxMajor: v[0] + 1 };
  }
  if (/^>=/.test(s)) {
    return { min: parseVersion(s.slice(2)) };
  }
  if (/^[~><=]/.test(s)) {
    throw new Error('不支持的 engines.node 约束（仅 >= / ^ / 裸版本）: ' + JSON.stringify(spec));
  }
  // 裸版本按 >= 处理。
  return { min: parseVersion(s) };
}

/** 三元组比较：a<b 返回负，a===b 0，a>b 正。 */
function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** 当前 node 是否满足约束。 */
function satisfies(spec, version = process.version) {
  const c = parseConstraint(spec);
  const cur = parseVersion(version);
  if (cmp(cur, c.min) < 0) return false;
  if (c.maxMajor !== undefined && cur[0] >= c.maxMajor) return false;
  return true;
}

function readEngineFloor() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const node = pkg?.engines?.node;
  if (typeof node !== 'string' || node.length === 0) {
    throw new Error('package.json 缺少 engines.node，无法执行 Node 引擎门禁');
  }
  return node;
}

function main() {
  if (process.argv.includes('--selftest')) {
    const cases = [
      ['>=22.14.0', 'v22.22.2', true],
      ['>=22.14.0', 'v22.14.0', true],
      ['>=22.14.0', 'v22.13.9', false],
      ['>=22.14.0', 'v21.0.0', false],
      ['^22.14.0', 'v22.99.0', true],
      ['^22.14.0', 'v23.0.0', false],
    ];
    let ok = true;
    for (const [spec, ver, want] of cases) {
      const got = satisfies(spec, ver);
      const pass = got === want;
      if (!pass) ok = false;
      console.log(
        `  selftest ${pass ? '✓' : '✗'} satisfies(${spec}, ${ver}) = ${got} (期望 ${want})`,
      );
    }
    if (!ok) {
      console.error('[checkNodeEngine] selftest 失败');
      process.exit(2);
    }
    console.log('[checkNodeEngine] selftest 全部通过');
    return;
  }

  const floor = readEngineFloor();
  if (!satisfies(floor)) {
    console.error(
      `[checkNodeEngine] ✗ Node 版本不足：当前 ${process.version} < 要求 ${floor}。\n` +
        `  请切换/安装符合 engines.node 的 Node（仓库已附 .nvmrc，可 \`nvm use\` 或把便携版 Node 纳入 PATH）。`,
    );
    process.exit(1);
  }
  console.log(`[checkNodeEngine] ✓ Node ${process.version} 满足 engines.node ${floor}`);
}

try {
  main();
} catch (e) {
  console.error('[checkNodeEngine] 解析错误: ' + (e?.message ?? e));
  process.exit(2);
}
