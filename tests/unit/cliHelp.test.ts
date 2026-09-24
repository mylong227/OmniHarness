/**
 * CLI 帮助**数据化**的回归（用户指令：帮助文本也不该硬写在代码里）。
 *
 * 被改的形态：整份帮助是 `argParser.printUsage()` 里一段 **73 行的字符串数组**，于是 CLI 表面有了
 * 第三份副本（旗标名 / 枚举取值 / 默认值在 `cliFlagTable`、`cliEnums`、`CliDefaults` 各一份，
 * 帮助里再抄一遍）—— 实测**已经漂移**：帮助写 `--storage-adapter memory|jsonl`，而解析期白名单
 * 早已是 `memory|jsonl|sqlite`（用户照帮助选不到 sqlite）。
 *
 * 现帮助的**文案**在 `defaults/cliHelp.json`（改文案不改代码），**枚举取值**在渲染时从
 * `cliEnums` 派生（占位符 `{{枚举源名}}`），无法解析即抛错。
 *
 * 本测试钉住六件事：① 结构与排版；② 枚举值确实派生（含那条漂移修复）；③ 占位符 fail-closed；
 * ④ 帮助不得宣传不存在的旗标；⑤ 新增旗标必须文档化（存量未文档化冻结）；⑥ 渲染确定性。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliHelp, HELP_ENUM_SOURCES, cliHelp } from '../../src/cli/cliHelp.js';
import { FLAG_ENUM_VALUES, FLAG_TABLE } from '../../src/cli/cliFlagTable.js';
import { STORAGE_ADAPTERS } from '../../src/cli/cliEnums.js';

/** 仓库根（dist/tests/unit → 上溯三级）。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * 存量「在 `FLAG_TABLE` 里但帮助未记载」的旗标（**冻结基线，只增即红**）。
 *
 * 这些是真实缺口（多属内部/调参旗标），但补齐它们会显著改变用户可见帮助 ⇒ 不在本次数据化范围内。
 * 新增旗标若未写进帮助，会出现在差集里 ⇒ 测试失败，必须二选一：写进帮助，或显式追加到本基线（并说明理由）。
 */
const UNDOCUMENTED_BASELINE: readonly string[] = [
  '--cost-budget-on-exceed',
  '--cost-budget-soft-ratio',
  '--cost-budget-usd',
  '--memory-encrypt',
  '--memory-key-file',
  '--model',
  '--model-circuit-breaker-open-ms',
  '--model-circuit-breaker-threshold',
  '--model-router',
  '--model-router-file',
  '--no-model-circuit-breaker',
  '--no-model-retry',
  '--prompt',
  '--stream-text',
  '--turn-token-budget',
];

test('① 结构与排版：标题 / 用法 / 命令 / 选项，描述列统一为 36', () => {
  const lines = cliHelp.render().split('\n');
  assert.strictEqual(lines[0], 'OmniHarness exec');
  assert.match(lines[1] ?? '', /^用法: omniharness exec/);
  assert.ok(lines.includes('选项:'), '应有选项段标题');
  const data = JSON.parse(readFileSync(join(repoRoot, 'defaults', 'cliHelp.json'), 'utf8')) as {
    commands: { usage: string; description: string }[];
    options: { spec: string; description: string }[];
  };
  // 行数 = 标题 + 用法 + 命令 + 选项标题 + 选项 + 结尾空行
  assert.strictEqual(
    lines.length,
    3 + data.commands.length + data.options.length + 1,
    '渲染行数必须与数据条目数一致（无丢行、无凭空补行）',
  );
  // 排版：描述列恰为 36（spec 过长时留 3 空格）——旧数组是手工对齐，参差不齐
  const resolve = (text: string): string =>
    text.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_f, name: string) =>
      (HELP_ENUM_SOURCES[name] ?? []).join('|'),
    );
  const check = (indent: number, spec: string, description: string): void => {
    const prefix = `${' '.repeat(indent)}${resolve(spec)}`;
    const line = lines.find((l) => l.startsWith(prefix));
    assert.ok(line !== undefined, `未找到行：${prefix}`);
    const expected = prefix.length + 3 <= 36 ? 36 : prefix.length + 3;
    assert.strictEqual(
      line.indexOf(description),
      expected,
      `描述列不符：${JSON.stringify(line)}（期望 ${expected}）`,
    );
  };
  for (const entry of data.commands) check(6, entry.usage, entry.description);
  for (const entry of data.options) check(2, entry.spec, entry.description);
});

test('② 枚举取值由单一来源派生（含 --storage-adapter 漂移的修复）', () => {
  const text = cliHelp.render();
  // 修的正是这条：帮助曾写 memory|jsonl，而白名单是 memory|jsonl|sqlite
  assert.ok(
    text.includes(`--storage-adapter ${STORAGE_ADAPTERS.join('|')}`),
    '帮助里的 --storage-adapter 取值必须由 cliEnums 派生（含 sqlite）',
  );
  // 凡在帮助里出现的「取值受枚举约束」的旗标，其取值清单必须是派生全量
  let checked = 0;
  for (const [flag, values] of Object.entries(FLAG_ENUM_VALUES)) {
    if (!text.includes(flag)) continue;
    checked += 1;
    assert.ok(
      text.includes(`${flag} ${values.join('|')}`),
      `${flag} 的取值必须是派生全量（期望 ${values.join('|')}）`,
    );
  }
  assert.ok(checked >= 10, `应覆盖到多数枚举旗标，实际 ${checked} 个`);
  // 渲染结果里不得残留占位符
  assert.ok(!text.includes('{{'), '渲染结果不得残留占位符');
});

test('③ 占位符 fail-closed：引用未登记的枚举源即抛错', () => {
  const base = {
    title: 't',
    usageLine: 'u',
    optionsTitle: '选项:',
    commands: [{ usage: 'c', description: 'd' }],
    options: [{ spec: '--x {{nope}}', description: 'd' }],
  };
  assert.throws(() => new CliHelp(base), /未登记的枚举源/);
  // 合法占位符可解析
  const ok = new CliHelp({
    ...base,
    options: [{ spec: '--storage-adapter {{storageAdapters}}', description: 'd' }],
  });
  assert.match(ok.render(), /--storage-adapter memory\|jsonl\|sqlite/);
  assert.deepStrictEqual([...ok.enumSources()], ['storageAdapters']);
  // 结构非法
  assert.throws(() => new CliHelp(null), /应为对象/);
  assert.throws(() => new CliHelp({ ...base, options: [] }), /应为非空数组/);
});

test('④ 帮助不得宣传不存在的旗标（幽灵文档）', () => {
  // 只查**选项段中以 `--` 开头**的条目：这些是一级旗标，照帮助敲下去必须能被解析，否则会「静默被忽略」。
  // 例外（CLI **自解析**旗标，不走 FLAG_TABLE 通用循环）：
  //   `--config` / `--profile` —— 装配层读配置时要先拿到它们；
  //   `--auth-required` —— 由 `serve` 子命令自行扫描（`cliServerCmds.runServe`；
  //   同处一起自解析的 `--oidc-*` 其实在 FLAG_TABLE 里有占位处理器，故不在本清单）。
  // 例外清单若腐化（某旗标已在 FLAG_TABLE，或已不在帮助里）会立刻失败。
  const parsedOutsideFlagTable = new Set(['--config', '--profile', '--auth-required']);
  const rendered = cliHelp.render();
  const escape = (flag: string): string => flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const topLevel = cliHelp
    .documentedFlags()
    .filter((flag) => new RegExp(`^ {2}${escape(flag)}( |$)`, 'm').test(rendered));
  const ghost = topLevel.filter(
    (flag) => FLAG_TABLE[flag] === undefined && !parsedOutsideFlagTable.has(flag),
  );
  assert.deepStrictEqual(
    ghost,
    [],
    `帮助宣传了不存在的旗标（既不在 FLAG_TABLE，也不在自解析例外里）：${ghost.join(' / ')}`,
  );
  // 例外清单不得腐化：登记的旗标必须确实「不在表里」且「在帮助里」
  for (const flag of parsedOutsideFlagTable) {
    assert.strictEqual(FLAG_TABLE[flag], undefined, `${flag} 已在 FLAG_TABLE ⇒ 请从例外清单移除`);
    assert.ok(topLevel.includes(flag), `${flag} 不在帮助里 ⇒ 请从例外清单移除`);
  }
});

test('⑤ 新增旗标必须文档化：未文档化集合等于冻结基线（只增即红）', () => {
  const documented = new Set(cliHelp.documentedFlags());
  const missing = Object.keys(FLAG_TABLE)
    .filter((flag) => !documented.has(flag))
    .sort();
  assert.deepStrictEqual(
    missing,
    [...UNDOCUMENTED_BASELINE].sort(),
    '新增旗标必须写进 defaults/cliHelp.json（或显式追加到基线并说明理由）',
  );
});

test('⑥ 渲染确定性：同数据恒同输出，且帮助源数据随包发布', () => {
  assert.strictEqual(cliHelp.render(), cliHelp.render());
  assert.ok(Object.keys(HELP_ENUM_SOURCES).length >= 14);
  // 数据文件必须存在（I6 门禁亦覆盖 builtinDefaults.json('cliHelp') 的随包发布）
  const raw = readFileSync(join(repoRoot, 'defaults', 'cliHelp.json'), 'utf8');
  assert.ok(raw.length > 1000, '帮助数据文件不应为空');
});
