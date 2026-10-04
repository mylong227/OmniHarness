/**
 * 生产级实现标准（`docs/CODE_STANDARD.md` §12）的判据——**含机械规则自证**。
 *
 * 为什么这个文件本身很重要：§12 的诉求是「拒绝 demo 式实现」。
 * 如果把这条纪律只写进文档，它自己就是一句 demo 级的口号——**文档不算强制**。
 * 故本判据做三件事：
 * ① 核对文档结构（§12 存在且七条判据 / 机械强制 / 评审口径齐备）；
 * ② 核对**技能包**真的带着这条纪律（`defaults/skills/harness-core.json`：新技能 + 编码标准技能的指向）
 *    ——技能是 agent 每次开工都会读到的东西，写进这里才算「写进对应的代码技能」；
 * ③ **仪器自证**：在一个临时 git 仓库里放一个含 `TODO` 与 `console.log` 的文件，
 *    真跑 `audit:standard:delta`，断言它**真的红**并**点名那条规则**；干净文件则绿。
 *    没有 ③，§12.2 的规则同样可能恒绿（本仓历史：判据真空通过过一次又一次）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();
const AUDIT = resolve(ROOT, 'scripts', 'auditStandards.mjs');

/**
 * 读仓库内文本文件。
 * @param rel 相对仓库根的路径
 * @returns 文件内容
 */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * 在临时 git 仓库里暂存一个 `src/x.ts` 并跑增量门禁。
 * @param body 文件内容
 * @returns 退出码与输出
 */
function runDeltaOn(body: string): { readonly code: number; readonly out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'omni-pg-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'probe.ts'), body, 'utf8');
  const git = (args: readonly string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
  };
  git(['init']);
  git(['config', 'user.email', 'probe@example.com']);
  git(['config', 'user.name', 'probe']);
  git(['add', 'src/probe.ts']);
  try {
    const out = execFileSync('node', [AUDIT, '--delta'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * 正对照夹具：合法的最小类模板（它必须绿）。
 *
 * **为什么用「字符串数组 + join」而不是模板字面量**：模板字面量里嵌 JSDoc 形状的文本会被
 * `audit:standard:delta` 的 JSDoc 缩进规则按「注释起始列」计算（实测在本文件报 2 处），
 * 那是判据夹具污染被测量对象——夹具本身也要过门禁。
 */
const CLEAN: string = [
  '/**',
  ' * 干净样例。',
  ' */',
  'export class Probe {',
  '  /**',
  '   * 回一句问候。',
  '   * @param name 名字',
  '   * @returns 问候语',
  '   */',
  '  public greet(name: string): string {',
  '    return name;',
  '  }',
  '}',
  '',
].join('\n');

/**
 * 反对照夹具：待办注释 + 调试残留 + 占位抛错（正好命中 §12.2 的三类）。
 *
 * 注意它**刻意**把标记放在字符串数组里：审计规则先按 AST 抹白字符串字面量再匹配，
 * 因此本文件自身保持干净，而写进临时仓库的那份文件含真实标记——这正好顺带证明
 * 「讨论标记的代码」与「含标记的代码」被区分开了。
 */
const DIRTY: string = [
  '/**',
  ' * 脏样例。',
  ' */',
  'export class Probe {',
  '  /**',
  '   * 干点活。',
  '   * @returns 结果',
  '   */',
  '  public work(): string {',
  '    // TODO: 以后再补真正的实现',
  "    console.log('debug');",
  "    throw new Error('not implemented');",
  '  }',
  '}',
  '',
].join('\n');

/**
 * 文档口吻夹具：注释里**用反引号包裹**地讨论标记（§12.2 约定）。
 *
 * 它必须绿——否则「写规则/写文档的人」会被自己的门禁逼着把话说含糊。
 * 反过来说，若有人把规则改成「注释一律不数」，下面的 BARE_TODO 会立刻红。
 */
const DOC_MENTION: string = [
  '/**',
  ' * 本类用于校验产物文本里是否含 `TODO` / `FIXME` 标记（文档口吻：反引号包裹）。',
  ' */',
  'export class Probe {',
  '  /**',
  '   * 判断是否含未完成标记。',
  '   * @param text 待检文本',
  '   * @returns 含标记为 true',
  '   */',
  '  public hasPlaceholder(text: string): boolean {',
  '    return text.length > 0;',
  '  }',
  '}',
  '',
].join('\n');

/**
 * 裸待办夹具：只有一行裸露的待办注释（没有其它标记）。
 *
 * 用途：证明「注释被整体忽略」这种退化实现会被抓住——文档口吻豁免**不等于**注释全免。
 */
const BARE_TODO: string = [
  '/**',
  ' * 样例。',
  ' */',
  'export class Probe {',
  '  /**',
  '   * 干点活。',
  '   * @returns 结果',
  '   */',
  '  public work(): string {',
  '    // TODO: 这里还差一半',
  '    return "x";',
  '  }',
  '}',
  '',
].join('\n');

test('§12 文档结构：七条判据 + 机械强制 + 评审口径齐备（文档不算强制，故另有 §12.2 与自证）', () => {
  const doc = read('docs/CODE_STANDARD.md');
  assert.match(doc, /^## 12\. 生产级实现标准（拒绝 demo 式）/m, '缺 §12 章节');
  assert.match(doc, /### 12\.1 七条硬性判据/, '缺七条判据小节');
  assert.match(doc, /### 12\.2 机械强制/, '缺机械强制小节');
  assert.match(doc, /### 12\.3 评审口径/, '缺评审口径小节');
  for (const clause of [
    '完整性',
    '失败面显式',
    '边界与资源有硬上限',
    '可观测',
    '可复现与幂等',
    '兼容与迁移显式化',
    '判据即交付',
  ]) {
    assert.ok(doc.includes(clause), `§12.1 缺判据「${clause}」`);
  }
  // 评审五问（答不上来即未完成）——这是「人评审」这一面的可执行形式。
  for (const question of [
    '失败路径在哪',
    '上限是多少',
    '谁观测它',
    '重复执行会怎样',
    '判据能变红吗',
  ]) {
    assert.ok(doc.includes(question), `§12.3 缺评审问题「${question}」`);
  }
  // 反 demo 声明本身必须在文档里（否则「拒绝 demo」只是口号）。
  assert.match(doc, /反 demo 声明/, '缺反 demo 声明');
  assert.match(doc, /以后再说.{0,4}不是交付状态/, '缺对「以后再说」的明确拒绝');
});

test('§12 写进代码技能：技能包带生产级技能，且编码标准技能指向 §12', () => {
  const pack = JSON.parse(read('defaults/skills/harness-core.json')) as {
    readonly skills: readonly {
      readonly name: string;
      readonly description: string;
      readonly instructions: string;
      readonly tags: readonly string[];
    }[];
  };
  const skill = pack.skills.find((s) => s.name === 'omniharness-production-grade');
  assert.ok(
    skill !== undefined,
    '技能包缺 omniharness-production-grade（纪律必须写进技能，否则 agent 读不到）',
  );
  assert.ok(skill!.instructions.includes('§12'), '技能必须指向 CODE_STANDARD §12（唯一出处）');
  for (const key of ['完整性', 'fail-closed', '上限', '可观测', '幂等', '迁移', '判据']) {
    assert.ok(skill!.instructions.includes(key), `技能说明缺要点「${key}」`);
  }
  assert.ok(
    skill!.tags.some((t) => t === '拒绝demo'),
    '标签需可检索（拒绝demo）',
  );
  const coding = pack.skills.find((s) => s.name === 'omniharness-coding-standard');
  assert.ok(
    coding?.instructions.includes('§12'),
    '编码标准技能必须指向 §12，说明「形态合格 ≠ 交付完成」',
  );
});

test('§12.2 机械强制：审计脚本里有「占位或调试残留」规则（新文件零容忍，只增即红）', () => {
  const script = read('scripts/auditStandards.mjs');
  assert.ok(script.includes('占位或调试残留'), '审计脚本缺该规则（写了文档却没有牙齿）');
  assert.ok(script.includes('placeholderMarkers'), '缺度量函数');
  assert.ok(script.includes('placeholderCount'), '缺度量字段（delta 比对需要它）');
  // 规则的正则覆盖面（字面量断言：改覆盖面必须同步改本节与判据）。
  for (const marker of [
    'TODO|FIXME|XXX|HACK',
    'console\\.(?:log|debug)',
    'debugger',
    'not[- ]implemented',
    '@ts-(?:ignore|expect-error)',
  ]) {
    assert.ok(script.includes(marker), `规则缺标记模式：${marker}`);
  }
});

test('§12.2 仪器自证（正对照）：干净文件过增量门禁', () => {
  const clean = runDeltaOn(CLEAN);
  assert.strictEqual(clean.code, 0, `干净样例不该被拦（实际输出：${clean.out.slice(0, 400)}）`);
  assert.match(clean.out, /增量门禁通过/);
});

test('§12.2 仪器自证（反对照）：含 TODO 与 console.log 的新文件必须被判红并点名规则', () => {
  const dirty = runDeltaOn(DIRTY);
  assert.notStrictEqual(dirty.code, 0, '脏文件必须被拦下——否则 §12.2 是恒绿的空门禁');
  assert.match(dirty.out, /占位或调试残留/, '必须点名该规则');
  assert.match(dirty.out, /TODO\/FIXME\/XXX\/HACK/, '报错要说明覆盖的标记集合');
});

test('§12.2 口吻区分：反引号包裹的「文档口吻」豁免，裸露的待办注释照样红', () => {
  // 文档口吻（反引号包裹）⇒ 绿：否则写规则/写文档的人被自己的门禁逼着说话含糊。
  const docMention = runDeltaOn(DOC_MENTION);
  assert.strictEqual(
    docMention.code,
    0,
    `文档口吻不该被拦（输出：${docMention.out.slice(0, 300)}）`,
  );

  // 裸待办 ⇒ 红：证明豁免**只针对文档口吻**，不是「注释一律不数」的退化实现。
  const bare = runDeltaOn(BARE_TODO);
  assert.notStrictEqual(bare.code, 0, '裸露的待办注释必须被拦（否则注释可以随便留 TODO）');
  assert.match(bare.out, /占位或调试残留/);
});
