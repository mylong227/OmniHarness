/**
 * 源码注释里的 docs 引用判据（2026-11-03 P0 裂缝清零 T0.1）。
 *
 * ## 它锁的是什么
 *
 * 「完美应用」上唯一的死链长在 `.ts` 注释里：`auditChain.ts` 曾指向不存在的
 * `docs/AUDIT_ATTESTATION.md`（「完整性 ≠ 签名」这句最该严谨的话没有正式文档可去），
 * 而 `scripts/docLinkCheck.mjs` 此前只扫 `*.md`，对 `.ts` 注释全盲。现在门禁已扩面
 * （docLinkCheck 的 src-mention 口径，存量冻结在 `scripts/docLinkBaseline.json`）；
 * 本判据锁三件事，防止同一裂缝复发：
 *
 * ① 信任模型文档必须存在、且被 auditChain / auditTypes 的注释真实指向（删文件 ⇒ 红）；
 * ② 旧死链路径不得回流到任何 src 注释；
 * ③ 「反引号 docs 提及」的抽取机制本身可用（正对照 + 死链可检出，红/绿可证）。
 *
 * 全树扫描由 docLinkCheck 门禁承担（`npm run regress` 会先跑门禁再跑判据），
 * 这里不做第二份全树口径，避免两处判定漂移。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, 'src');

/** 反引号包住的 `docs/…` 路径（与 scripts/docLinkCheck.mjs 的 SRC_DOCS_RE 同口径）。 */
const DOCS_REF_RE =
  /`(docs\/[A-Za-z0-9_./-]+\.(?:ts|tsx|md|json|mjs|cjs|py|rs|yml|yaml|toml|sh))`/g;

/**
 * 递归收集 src 下的 .ts 文件路径（相对 ROOT、正斜杠化，便于与基线 key 对照）。
 * @param dir 起始目录。
 * @param out 累加数组。
 * @returns 相对路径列表。
 */
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      srcFiles(full, out);
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full.replaceAll('\\', '/'));
    }
  }
  return out;
}

test('① 信任模型文档存在，且被 auditChain / auditTypes 注释真实指向（删文件 ⇒ 红）', () => {
  const attestation = join(ROOT, 'docs', 'audit', 'ATTESTATION.md');
  assert.ok(existsSync(attestation), 'docs/audit/ATTESTATION.md 不存在——信任模型没有正式文档');
  const chain = readFileSync(join(ROOT, 'src', 'apps', 'audit', 'auditChain.ts'), 'utf8');
  const types = readFileSync(join(ROOT, 'src', 'apps', 'audit', 'auditTypes.ts'), 'utf8');
  assert.match(chain, /docs\/audit\/ATTESTATION\.md/, 'auditChain.ts 必须指向信任模型文档');
  assert.match(types, /docs\/audit\/ATTESTATION\.md/, 'auditTypes.ts 必须指向信任模型文档');
});

test('② 旧死链路径 docs/AUDIT_ATTESTATION.md 不得回流到任何 src 注释', () => {
  const offenders: string[] = [];
  for (const file of srcFiles(SRC_DIR)) {
    if (readFileSync(file, 'utf8').includes('docs/AUDIT_ATTESTATION.md')) {
      offenders.push(file);
    }
  }
  assert.deepStrictEqual(offenders, [], '旧死链路径回流（应指向 docs/audit/ATTESTATION.md）');
});

test('③ docs 提及抽取器可用：真实文件命中、死链可检出（机制红/绿可证）', () => {
  const comment = '见 `docs/audit/README.md`，别去 `docs/definitely-missing-xyz.md` 找。';
  const mentions = [...comment.matchAll(DOCS_REF_RE)].map((m) => m[1]);
  assert.deepStrictEqual(mentions, ['docs/audit/README.md', 'docs/definitely-missing-xyz.md']);
  const resolvable = mentions.filter((target) => existsSync(join(ROOT, target)));
  assert.deepStrictEqual(resolvable, ['docs/audit/README.md'], '死链必须能被该机制检出');
});
