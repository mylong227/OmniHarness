/**
 * CLI **旗标认识面**判据（2026-10-06 第五十七轮 ⑥）。
 *
 * ## 它锁的是什么
 *
 * `ArgParser.parseArgs` 此前对未知旗标**静默 `continue`**：拼错的旗标无声无效，其取值还会被
 * `collectPositional` 当成 prompt（`--porad x` ⇒ prompt 变成 `x`）。现在它对不认识的 `-` 开头
 * token **throw**。这条改动只有在"认识面清单与源码里的真实读取点一致"时才安全——
 * 漏登记一个正在工作的子命令旗标 ⇒ 打掉真实功能；多登记一个没人读的名字 ⇒ 白名单腐化。
 * 故本判据**双向**机械核对，不靠自觉。
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | 源码里任何 `reader.value/has/...('--x')` 式**读取点**都必须被 `isKnownFlag` 接受（防漏登记） |
 * | ② | `KNOWN_EXTRA_FLAGS` 不得与 `FLAG_TABLE` / `VALUE_FLAGS` 重复（防两处各写一份而漂移） |
 * | ③ | `KNOWN_EXTRA_FLAGS` 每一项都必须在 `src/cli/**` 里真的被读取（防白名单腐化成"什么都放行"） |
 * | ④ | 实跑：未知旗标必须非零退出并给出可读原因（修复前它是静默通过） |
 * | ⑤ | 正对照：`--help` 仍打印用法、已知旗标仍被接受（判据不是"一律拒绝"） |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CliFlagTable, FLAG_TABLE, VALUE_FLAGS } from '../../src/cli/cliFlagTable.js';
import { KNOWN_EXTRA_FLAGS } from '../../src/cli/cliFlagTable.js';

const ROOT = process.cwd();
const CLI_DIR = join(ROOT, 'src', 'cli');
const CLI_ENTRY = join(ROOT, 'dist', 'src', 'cli', 'exec.js');

/** `src/cli/**` 下的全部 .ts 源文本。 */
function cliSources(): readonly { readonly name: string; readonly text: string }[] {
  return readdirSync(CLI_DIR)
    .filter((n) => n.endsWith('.ts'))
    .map((n) => ({ name: n, text: readFileSync(join(CLI_DIR, n), 'utf8') }));
}

/**
 * 抽出源文本里所有"读取器 + 字面旗标名"的读取点。
 *
 * **2026-10-06 补洞（真实缺陷）**：原正则只认 `.has(`/`.value(`/`flagValue(` 这类**读取器**写法，
 * 于是 `serveArgs.includes('--auto-approve')`（`cliServerCmds.ts` 里的真实读取点）**完全扫不到** ⇒
 * 该旗标从未登记，而第五十七轮的"未知旗标 fail-closed"把它打死了：`serve --auto-approve` 报未知旗标退出，
 * 而 `--help`/README 都还写着它。判据扫不到的读取点 = 判据给不出保护，故把 `.includes(` 一并纳入。
 * @param text 源文本。
 * @returns 旗标名数组（去重）。
 */
function readFlags(text: string): readonly string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(flagReadPattern())) {
    if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found];
}

/**
 * 「源码读取旗标」的统一识别式：reader 式（`.has(`/`.value(`/`flagValue(`…）**与** `Array.includes(`。
 * 每次返回**新**正则（避免 `/g` 共享 `lastIndex` 造成的状态串味），供判据①与③共用——
 * 两处各写一份正是上一轮漏掉 `.includes(` 的成因。
 * @returns 带 `g` 标志的新正则。
 */
function flagReadPattern(): RegExp {
  return /(?:\.has\(|\.value\(|\.values\(|\.includes\(|flagValue\(|flagNumber\(|enumOf\(|valueOf\()\s*[^)]*?'(--[a-z][a-z0-9-]*)'/g;
}

test('① 源码里每个旗标读取点都必须被 isKnownFlag 接受（漏登记 ⇒ 打掉真实功能）', () => {
  const missing: string[] = [];
  for (const { name, text } of cliSources()) {
    for (const flag of readFlags(text)) {
      if (!CliFlagTable.isKnownFlag(flag)) missing.push(`${name}: ${flag}`);
    }
  }
  assert.deepStrictEqual(
    missing,
    [],
    `以下旗标在源码里被读取，但不在认识面内：\n${missing.join('\n')}`,
  );
});

test('② KNOWN_EXTRA_FLAGS 不得与 FLAG_TABLE / VALUE_FLAGS 重复（单一来源）', () => {
  const duplicated = [...KNOWN_EXTRA_FLAGS].filter(
    (f) => FLAG_TABLE[f] !== undefined || VALUE_FLAGS.has(f),
  );
  assert.deepStrictEqual(
    duplicated,
    [],
    `这些名字已在 FLAG_TABLE/VALUE_FLAGS 里 ⇒ 请从 KNOWN_EXTRA_FLAGS 移除：${duplicated.join(', ')}`,
  );
});

test('③ KNOWN_EXTRA_FLAGS 每一项都真的被读取（防白名单腐化成"什么都放行"）', () => {
  const allText = cliSources()
    .map((s) => s.text)
    .join('\n');
  const unread = [...KNOWN_EXTRA_FLAGS].filter((flag) => {
    // 只认"出现在读取器/includes 参数位置"的字面量，避免被文档字符串误判为已使用。
    const atReader = new RegExp(
      `(?:\\.has\\(|\\.value\\(|\\.values\\(|\\.includes\\(|flagValue\\(|flagNumber\\(|enumOf\\(|valueOf\\()[^)]*'${flag}'`,
    );
    return !atReader.test(allText);
  });
  assert.deepStrictEqual(
    unread,
    [],
    `这些旗标登记为"子命令自解析"但全仓没人读 ⇒ 白名单腐化：${unread.join(', ')}`,
  );
});

test('⑥ 实跑正对照：文档/`--help` 写着的子命令旗标必须真被接受（`--auto-approve` 曾被打死）', () => {
  // 2026-10-06 真实缺陷：`serve --auto-approve`（`--help` 与 README 都写着、代码里也真的读它）
  // 因从未登记进认识面，被"未知旗标 fail-closed"直接打死。这里用**短命进程**做正对照：
  // 同时给一个真未知旗标 ⇒ 报错必须指向它，而**不能**指向 --auto-approve（后者被接受、只是随后失败）。
  const r = spawnSync(
    process.execPath,
    [CLI_ENTRY, 'serve', '--auto-approve', '--definitely-not-a-flag'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.match(out, /未知旗标 --definitely-not-a-flag/, '真未知旗标必须被指名报出');
  assert.doesNotMatch(out, /未知旗标 --auto-approve/, '--auto-approve 是合法旗标，不得被判未知');
});

test('④ 实跑：未知旗标必须非零退出且给出可读原因（修复前静默通过）', () => {
  const r = spawnSync(process.execPath, [CLI_ENTRY, '--definitely-not-a-flag', 'x'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.notStrictEqual(r.status, 0, '未知旗标必须非零退出');
  assert.match(
    `${r.stdout ?? ''}${r.stderr ?? ''}`,
    /未知旗标/,
    '必须打印可读原因（含正确写法提示）',
  );
});

test('⑤ 正对照：已知旗标被接受、--help 仍打印用法（判据不是一律拒绝）', () => {
  // 认识面三来源各取一例
  assert.ok(CliFlagTable.isKnownFlag('--mock'), 'FLAG_TABLE 旗标应被认识');
  assert.ok(CliFlagTable.isKnownFlag('--port'), '子命令自解析旗标应被认识');
  assert.ok(CliFlagTable.isKnownFlag('--profile'), 'VALUE_FLAGS 旗标应被认识');
  assert.strictEqual(CliFlagTable.isKnownFlag('--definitely-not-a-flag'), false);

  const help = spawnSync(process.execPath, [CLI_ENTRY, '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(`${help.stdout ?? ''}`, /omniharness/i, '--help 必须仍打印用法');
  assert.strictEqual(help.status, 2, '--help 的退出码仍是 2（与既有一致）');

  // 合法子命令旗标不得被打掉：`capability list --json` 必须**跑进子命令**（而不是报未知旗标）
  const cap = spawnSync(process.execPath, [CLI_ENTRY, 'capability', 'list', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.doesNotMatch(
    `${cap.stdout ?? ''}${cap.stderr ?? ''}`,
    /未知旗标/,
    '合法子命令旗标被误判为未知',
  );
});
