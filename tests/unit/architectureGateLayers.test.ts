/**
 * `ports→实现层` 规则**覆盖完整性**判据（A4，2026-10-11）。
 *
 * ## 它拦的是什么
 *
 * 该规则原先硬编码 6 个前缀（`core/ adapters/ config/ composition/ context/ search/`），
 * 于是 `spark/ skill/ security/ server/ evolution/ subagent/ mcp/ worker/ native/ a2a/ plugin/`
 * 等层的 `ports→实现层` 边**完全不可见**，而日志标签只列 3 个前缀（`core/adapters/config`），
 * 读起来像"已全覆盖"。一条铁律实际只覆盖 6/15 个层，且**新目录不会自动纳入**。
 *
 * ## 本轮的三条判据
 *
 * ① **动态枚举**（结构）：实现层必须由 `readdirSync(src)` 现算，源码里**不得**再出现那 6 个前缀的
 *    硬编码数组——否则"新增目录自动纳入"会退化成"靠人记得改脚本"；
 * ② **层集合与磁盘一致**（行为）：门禁打印的层数必须等于「`src/` 顶层的目录数 − `ports/` − 基础层」，
 *    用真实文件系统核对（脚本自述的数字不算证据）；
 * ③ **白名单无死条目**（行为）：白名单里每条 id 都必须**仍然存在**于门禁实际报出的违规里——
 *    清偿后忘了删白名单，会让"存量债务"这个数字虚高，也让棘轮失去意义（本仓"基线只许收紧"的同源要求）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（编译产物在 `dist/tests/unit/`）。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 读文件原文。 */
function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** 跑一次架构门禁，返回 stdout+stderr 与退出码。 */
function runGate(): { readonly out: string; readonly code: number } {
  try {
    const out = execFileSync('node', [join(REPO_ROOT, 'scripts', 'architectureGate.mjs')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

test('① 实现层必须动态枚举（禁止退回硬编码前缀）', () => {
  const source = read('scripts/architectureGate.mjs');
  assert.ok(
    /readdirSync\(root,\s*\{\s*withFileTypes:\s*true\s*\}\)/.test(source),
    '实现层必须用 readdirSync 现算（新增目录自动纳入），源码里找不到该调用',
  );
  assert.ok(
    !/\['core\/',\s*'adapters\/',\s*'config\/'/.test(source),
    '不得再出现硬编码的层数组——那正是"9 个层的新增违规隐形"的成因',
  );
  // 基础层必须显式声明（否则 `errors/` `util/` 会被误判成实现层，产生 5 条假违规）
  assert.ok(/FOUNDATION_LAYERS\s*=\s*\[/.test(source), '基础层必须显式枚举');
  for (const layer of ['errors/', 'util/']) {
    assert.ok(source.includes(`'${layer}'`), `基础层缺 ${layer}`);
  }
});

test('② 门禁打印的层数必须等于磁盘实况（脚本自述不算证据）', () => {
  const foundation = ['errors', 'util'];
  const expected = readdirSync(join(REPO_ROOT, 'src'), { withFileTypes: true }).filter(
    (e) => e.isDirectory() && e.name !== 'ports' && !foundation.includes(e.name),
  ).length;
  assert.ok(expected >= 10, `实现层数量异常（${String(expected)}）⇒ 本判据的基准已失效`);
  const { out } = runGate();
  const m = /\[3\.5\] ports→实现层（[^）]*；(\d+) 个层/.exec(out);
  assert.ok(m !== null, `门禁输出里没找到层数（格式变了？）：\n${out.slice(0, 400)}`);
  assert.strictEqual(
    Number(m[1]),
    expected,
    `门禁枚举了 ${m[1]} 个层，磁盘实为 ${String(expected)} 个 ⇒ 覆盖不全或有层被漏掉`,
  );
});

test('③ 白名单不得有死条目：每条 id 都必须仍然存在于实际违规里', () => {
  const source = read('scripts/architectureGate.mjs');
  const block = /const PORTS_IMPL_WL = new Set\(\[([\s\S]*?)\]\);/.exec(source)?.[1] ?? '';
  const whitelisted = [...block.matchAll(/'([^']+->[^']+)'/g)].map((m) => m[1] ?? '');
  assert.ok(whitelisted.length > 0, '白名单解析为空 ⇒ 本判据空转（先查解析正则）');
  const { out } = runGate();
  const section = out.slice(out.indexOf('[3.5]'), out.indexOf('[5]'));
  const reported = new Set(
    [...section.matchAll(/([a-z0-9]+\/[^\s]*->[a-z0-9]+\/[^\s]*)/g)].map((m) => m[1] ?? ''),
  );
  const dead = whitelisted.filter((id) => !reported.has(id));
  assert.deepStrictEqual(
    dead,
    [],
    `这些白名单条目已不再违规（多半是 ports 依赖已收口）⇒ 必须从 PORTS_IMPL_WL 删掉，` +
      `否则"存量债务"数字虚高、棘轮失真：\n${dead.join('\n')}`,
  );
});
