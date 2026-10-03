/**
 * **架构说明书与代码一致性**判据（G20-b，2026-10-03 第二十三轮）。
 *
 * ## 为什么需要它
 *
 * 旧版 `ARCHITECTURE_SPEC.md` 之所以要归档重写，根因不是"写得不好"，而是**它会漂移**：
 * 它自述"311 TS 文件 / 31500 行"，而当时全仓已 900+ 文件——**没人被拦下**，于是旧数字一路被当现状引用。
 *
 * 新版把两类陈述分开处理：
 *  - **规模数字**：一律标注**日期 + 口径**（逐文件求和），并由 `CODE_STANDARD.md` §11.1 的规则约束；
 *  - **结构声明**（依赖清单 / 端口目录 / ADR / 门禁标签）：**逐条与代码核对**——本文件就是那把尺子。
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | 文档存在，且带**快照日期**与**行数口径**说明（口径与 `CODE_STANDARD.md` §11.1 同源） |
 * | ② | 文档声明的**运行时依赖**逐条等于 `package.json` 的 `dependencies`（名字 + 版本） |
 * | ③ | 文档声明的**端口子目录**逐条等于磁盘上的 `src/ports/*` 目录 |
 * | ④ | 文档声明的**ADR 列表**逐条等于 `docs/adr/*.md`（除 README） |
 * | ⑤ | 文档里的**架构门禁规则标签**逐条等于 `scripts/architectureGate.mjs` 实际打印的标签 |
 * | ⑥ | 文档里的**门禁 id** 逐条存在于 `scripts/runGates.mjs`（且两层归属一致） |
 * | ⑦ | 文档在 `docs/README.md` 与 `docs/llms.txt` 里登记（否则没人找得到） |
 * | ⑧ | 归档副本仍在 `archive/` 且仍带归档横幅（G20 的成果不被回退） |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/**
 * 读仓库内文本文件。
 * @param rel 相对仓库根的路径。
 * @returns 文件内容。
 */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

const SPEC = read('docs/ARCHITECTURE_SPEC.md');
const CODE_STANDARD = read('docs/CODE_STANDARD.md');

test('① 文档存在，且带快照日期与行数口径说明（与 CODE_STANDARD §11.1 同源）', () => {
  assert.match(SPEC, /^# OmniHarness 工程项目架构说明书（现行）/m, '缺标题或未标"现行"');
  assert.match(SPEC, /\*\*快照日期\*\*：\*\*\d{4}-\d{2}-\d{2}\*\*/, '必须标注快照日期');
  assert.match(SPEC, /逐文件/, '必须写明行数口径是逐文件求和');
  assert.match(SPEC, /Measure-Object -Line/, '必须点明错误口径（否则下一个人还会用）');
  // 与标准同源：标准里也必须写着同一条口径。
  assert.match(CODE_STANDARD, /逐文件/, 'CODE_STANDARD §11.1 的口径说明不见了');
});

test('② 声明的运行时依赖逐条等于 package.json 的 dependencies', () => {
  const pkg = JSON.parse(read('package.json')) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  const declared = Object.entries(pkg.dependencies ?? {});
  assert.ok(declared.length > 0, 'package.json 没有运行时依赖？');
  for (const [name, version] of declared) {
    assert.ok(
      SPEC.includes(`${name}@${version}`),
      `文档未逐字写出运行时依赖 ${name}@${version}（改依赖必须同步本文）`,
    );
  }
  // 反向：文档里写的运行时依赖数量声明必须与实现一致。
  assert.match(
    SPEC,
    new RegExp(`运行时依赖（${String(declared.length)}）`),
    `文档声明的运行时依赖个数与 package.json（${String(declared.length)} 个）不一致`,
  );
});

test('③ 声明的端口子目录逐条等于磁盘上的 src/ports/*', () => {
  const actual = readdirSync(join(ROOT, 'src', 'ports'))
    .filter((name) => statSync(join(ROOT, 'src', 'ports', name)).isDirectory())
    .sort();
  const row = /端口子目录（(\d+)，与磁盘一致）\*\*：(.+?)。/s.exec(SPEC);
  assert.ok(row !== null, '文档缺"端口子目录"声明行');
  const count = row[1] ?? '';
  const list = row[2] ?? '';
  assert.strictEqual(
    Number(count),
    actual.length,
    `文档写的目录数（${count}）与磁盘（${String(actual.length)}）不一致`,
  );
  const declared = [...list.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]!).sort();
  assert.deepStrictEqual(
    declared,
    actual,
    '文档的端口目录列表与磁盘不一致（新增/改名端口目录必须同步本文）',
  );
});

test('④ 声明的 ADR 列表逐条等于 docs/adr/*.md', () => {
  const actual = readdirSync(join(ROOT, 'docs', 'adr'))
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .map((name) => name.replace(/\.md$/, ''))
    .sort();
  const declared = [...SPEC.matchAll(/`(\d{4}-[a-z0-9-]+)`/g)].map((m) => m[1]!).sort();
  assert.deepStrictEqual(
    declared,
    actual,
    '文档的 ADR 列表与 docs/adr/ 不一致（新增 ADR 必须同步本文）',
  );
});

test('⑤ 架构门禁规则标签逐条等于架构门禁实际打印的标签', () => {
  const gate = read('scripts/architectureGate.mjs');
  const labels = [
    '[1] core→adapters 违规',
    '[2] adapters→core 违规',
    '[3] ports 纯度（第三方裸导入 / class 实现',
    '[3.5] ports→实现层（core/adapters/config',
    '[5] 依赖环（Tarjan SCC',
    '[4] 目录平铺告警（直接 .ts > 30，非阻断）',
  ];
  for (const label of labels) {
    assert.ok(gate.includes(label), `架构门禁源码里找不到标签 ${label}（本判据需同步更新）`);
    assert.ok(SPEC.includes(label), `架构说明书未写出标签 ${label}（与门禁实际输出不一致）`);
  }
});

test('⑥ 门禁 id 与两层归属逐条等于 runGates.mjs', () => {
  const gates = read('scripts/runGates.mjs');
  const entries = [...gates.matchAll(/id:\s*'([^']+)',\s*\n\s*tier:\s*'([^']+)'/g)].map((m) => ({
    id: m[1]!,
    tier: m[2]!,
  }));
  assert.ok(entries.length >= 10, `门禁条数异常：${String(entries.length)}`);
  for (const { id } of entries) {
    assert.ok(SPEC.includes(`\`${id}\``), `架构说明书未列出实际存在的门禁 ${id}`);
  }
  const typed = entries.filter((e) => e.tier === 'typed').map((e) => e.id);
  const fast = entries.filter((e) => e.tier === 'fast').map((e) => e.id);
  // 文档的 typed 行形如：`| **typed**（`npm run gate:typed`） | `tsc`、`eslint-typed`（…） |`
  const typedLine = /\*\*typed\*\*[^|]*\|([^|]*)\|/.exec(SPEC)?.[1] ?? '';
  assert.ok(typedLine !== '', '文档缺 typed 层的门禁行');
  for (const id of typed) {
    assert.ok(typedLine.includes(`\`${id}\``), `${id} 属 typed 层，但文档的 typed 行没写它`);
  }
  assert.ok(fast.length > typed.length, '快层应包含绝大多数门禁（分层口径）');
});

test('⑦ 说明书在 docs/README.md 与 llms.txt 里登记', () => {
  assert.match(read('docs/README.md'), /ARCHITECTURE_SPEC\.md/, '文档索引未登记架构说明书');
  assert.match(read('docs/llms.txt'), /ARCHITECTURE_SPEC\.md/, '机器可读索引未登记架构说明书');
});

test('⑧ 归档副本仍在 archive/ 且仍带归档横幅（G20 成果不被回退）', () => {
  // 归档副本改名带日期（`ARCHITECTURE_SPEC_2026-09.md`）：与新现行版**同名会歧义**，
  // 也会让"现行文档不得以旧路径引用归档物"这条判据无法机械判定（2026-10-03 实测踩到）。
  const archived = read('docs/archive/ARCHITECTURE_SPEC_2026-09.md');
  assert.match(archived, /已归档（\d{4}-\d{2}-\d{2}/, '归档副本缺归档横幅');
  assert.ok(!/^# OmniHarness 工程项目架构说明书（现行）/m.test(archived), '归档副本不该自称"现行"');
});
