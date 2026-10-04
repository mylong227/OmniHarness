/**
 * **文档布局**判据（G20 文档瘦身，2026-10-03 第十八轮）。
 *
 * ## 它锁的是什么
 *
 * `docs/` 曾经堆了 33 份根级文档：旧审计、旧计划、旧调研与现行纪律混在一起，于是"旧数字被当现状"
 * 成了真实风险（典型：`ARCHITECTURE_SPEC.md` 自述"311 TS 文件 / 31500 行"，而当时全仓已 900+ 文件）。
 * G20 的做法是**只留 SSOT + 现行纪律 + 用户文档**，其余移入 `docs/archive/` 并逐份加归档横幅。
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | `docs/` 根下的 `.md` **只允许**在白名单内（不在 = 有人又往根上堆文档，必须显式决定去向） |
 * | ② | `archive/**` 下每份 `.md`（除索引自身）**必须带归档横幅**（把"这是历史"写在文件自身里） |
 * | ③ | 归档**索引完整**：`docs/archive/README.md` 必须逐份列出归档文件（不许有孤儿） |
 * | ④ | **现行索引自洽**：`docs/README.md` 与 `docs/llms.txt` 里的每个文档链接都必须指向**真实存在**的文件 |
 * | ⑤ | 现行文档**不得**指向归档物的旧路径（引用归档必须写 `archive/` 前缀） |
 *
 * 判据④为什么必要：索引是"现行权威入口"的清单，一旦指向已归档/已删文件，就会把历史材料重新
 * 推给读者（尤其 `llms.txt` 是给自动化工具读的）。G20 落地的当天，`docs/README.md` 与 `llms.txt`
 * 都正指向十来个已归档文档——正是这条判据要防的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const DOCS = join(ROOT, 'docs');
const ARCHIVE = join(DOCS, 'archive');

/**
 * `docs/` 根允许存在的文档（SSOT + 现行纪律 + 用户文档）。
 *
 * 新增一份根级文档 = 显式改这份白名单：逼作者回答"它属于哪一类"，而不是把历史报告随手丢在根上。
 */
const ROOT_ALLOWLIST: readonly string[] = [
  // SSOT 与当前依据
  'PROJECT_BOARD.md',
  'ARCHITECTURE_UPGRADE_2026-10.md',
  // G20-b（2026-10-03）：架构说明书按现状**重写**并回到根级 —— 这是显式决定，故白名单加一行。
  'ARCHITECTURE_SPEC.md',
  // 自进化商业落地方案研究报告（2026-10-04 显式登记）：带日期快照，市场数字为二手来源须复核。
  'EVOLUTION_COMMERCIALIZATION_2026-10.md',
  // 自进化先行研究调研与自研方案（2026-10-04 显式登记）：机制级择优学习表 + GEE 自研设计，外部数字为检索快照。
  'EVOLUTION_RD_RESEARCH_2026-10.md',
  // 进化域架构升级方案（2026-10-04 显式登记）：GEE Kernel v1 实施蓝图，配套 ADR-0008，未实现前不得当现状引用。
  'EVOLUTION_ARCH_UPGRADE_2026-10.md',
  // 目标架构蓝图（2026-10-04 显式登记）：Evolvix-Ω 终局态，Wave A–E 分波浪路线，未实现前不得当现状引用。
  'ARCHITECTURE_TARGET_2026-10.md',
  // Evolvix-Ω 架构规格书（2026-10-04 显式登记）：实现级契约/端口/模块/流程规格，全部为设计产物未实现。
  'EVOLVIX_SPEC_2026-10.md',
  // 现行纪律
  'CODE_STANDARD.md',
  'DEPENDENCY_POLICY.md',
  'API_STABILITY.md',
  'PORTS_CONTRACT.md',
  // 用户/第三方文档
  'README.md',
  'QUICKSTART.md',
  'PLUGIN_GUIDE.md',
  'contributing.md',
  'integration.md',
  'protocol.md',
  'DOMAIN_SLICE_TEMPLATE.md',
];

/** 归档横幅的判据字串（`scripts` 侧生成时同源）。 */
const ARCHIVE_MARKER = '已归档（';

/** 递归列出目录下所有 .md（相对给定根）。 */
function markdownUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith('.md')) out.push(relative(root, abs).split(sep).join('/'));
    }
  };
  walk(root);
  return out;
}

/** 读出文本里所有 markdown 链接目标（只取本地 `.md` 目标，跳过 http/锚点）。 */
function localDocLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]!;
    if (target.startsWith('http') || target.startsWith('#')) continue;
    out.push(target.split('#')[0]!);
  }
  return out;
}

test('① docs/ 根只允许白名单内的文档（新增根级文档必须显式决定去向）', () => {
  const actual = markdownUnder(DOCS).filter((rel) => !rel.includes('/'));
  const unexpected = actual.filter((name) => !ROOT_ALLOWLIST.includes(name));
  assert.deepStrictEqual(
    unexpected,
    [],
    `docs/ 根出现未登记文档：${unexpected.join('、')}\n` +
      '若它是历史审计/计划/调研 ⇒ 移入 docs/archive/ 并逐份加归档横幅；' +
      '若确为现行文档 ⇒ 加进本判据的白名单并在 docs/README.md 登记。',
  );
  // 白名单里的每一项都必须真的存在（否则白名单本身在撒谎）。
  const missing = ROOT_ALLOWLIST.filter((name) => !existsSync(join(DOCS, name)));
  assert.deepStrictEqual(missing, [], `白名单列了不存在的文档：${missing.join('、')}`);
});

test('② archive/ 下每份文档都必须带归档横幅（漏加即红）', () => {
  const files = markdownUnder(ARCHIVE).filter((rel) => rel !== 'README.md');
  assert.ok(files.length > 40, `归档文件数异常偏少（${String(files.length)}）：确认迁移是否被回退`);
  const missing: string[] = [];
  for (const rel of files) {
    const text = readFileSync(join(ARCHIVE, rel), 'utf8');
    if (!text.includes(ARCHIVE_MARKER)) missing.push(rel);
  }
  assert.deepStrictEqual(
    missing,
    [],
    `以下归档文档缺横幅（读者会把它当现行材料）：${missing.join('、')}\n` +
      '横幅要求：正文顶部（标题行之后）写明「已归档（日期）」并指向现行 SSOT。',
  );
});

test('③ 归档索引完整：每份归档文件都在 docs/archive/README.md 里列出', () => {
  const index = readFileSync(join(ARCHIVE, 'README.md'), 'utf8');
  const files = markdownUnder(ARCHIVE).filter((rel) => rel !== 'README.md');
  const missing = files.filter((rel) => !index.includes(`\`${rel}\``));
  assert.deepStrictEqual(
    missing,
    [],
    `归档索引漏列（归档物成了孤儿，没人能找到）：${missing.join('、')}`,
  );
});

test('④ 现行索引自洽：docs/README.md 与 llms.txt 的文档链接必须指向真实文件', () => {
  for (const rel of ['README.md', 'llms.txt']) {
    const text = readFileSync(join(DOCS, rel), 'utf8');
    const broken: string[] = [];
    for (const target of localDocLinks(text)) {
      if (!target.endsWith('.md') && !target.endsWith('/')) continue;
      const abs = join(DOCS, target.replace(/\/$/, ''));
      if (target.endsWith('/')) {
        if (!existsSync(abs)) broken.push(target);
        continue;
      }
      if (!existsSync(abs)) broken.push(target);
    }
    assert.deepStrictEqual(
      broken,
      [],
      `docs/${rel} 里的链接指向不存在的文件（索引在把读者推向历史材料/已删文件）：${broken.join('、')}`,
    );
  }
});

test('⑤ 现行文档不得以旧路径引用归档物（引用归档必须带 archive/ 前缀）', () => {
  const archivedNames = new Set(
    markdownUnder(ARCHIVE)
      .filter((rel) => rel !== 'README.md' && !rel.includes('/'))
      .map((rel) => rel),
  );
  const offenders: string[] = [];
  for (const rel of markdownUnder(DOCS)) {
    if (rel.startsWith('archive/')) continue;
    const text = readFileSync(join(DOCS, rel), 'utf8');
    for (const target of localDocLinks(text)) {
      const base = target.split('/').pop() ?? '';
      // 引用归档目录本身（archive/...）或带 archive 前缀的路径都合法。
      if (target.includes('archive/')) continue;
      if (archivedNames.has(base)) offenders.push(`${rel} → ${target}`);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `现行文档仍在用旧路径引用归档物：${offenders.join('、')}\n` +
      '改写为 archive/<name>，并在正文写明「历史记录」。',
  );
});

test('⑥ 归档横幅内容可复核：含归档日期与现行 SSOT 指向', () => {
  const sample = readFileSync(join(ARCHIVE, 'ARCHITECTURE_SPEC_2026-09.md'), 'utf8');
  assert.match(sample, /已归档（\d{4}-\d{2}-\d{2}/, '横幅必须写明归档日期');
  assert.match(sample, /PROJECT_BOARD\.md/, '横幅必须指向现行唯一事实源');
  assert.match(sample, /不再代表现状/, '横幅必须明确"数字不再代表现状"');
});
