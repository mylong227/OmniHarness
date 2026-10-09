/**
 * CLI 未知旗标**拼写建议**的判据（2026-10-08 易用性轮）。
 *
 * 被改的形态：`--modle` 这类手滑只会得到「本 CLI 不认识它；用 --help 查看全部旗标」——
 * 而 `--help` 是 100+ 行全量清单，用户得自己在里面找那个正确的名字。
 *
 * 本测试钉住五件事：
 *   ① **认得出手滑**：换位 / 少字母 / 多字母 / 少打一个横线，都必须给出正确建议；
 *   ② **不瞎猜**（负对照，最重要的一条）：毫无关系的名字必须**不给**建议——
 *      猜错的建议比没有建议更糟（把用户引到另一个错误上，还让人怀疑解析器）；
 *      含一条**实测踩过的**具体反例：`--work` 曾因"距离 1"被建议成 `--fork`；
 *   ③ **并列时闭嘴**：两个候选一样近时返回 null，而不是随便挑一个；
 *   ④ **前缀缩写只在唯一时**给出；
 *   ⑤ **接线与契约**：报错文案仍以 `未知旗标 <token>` 相连（既有判据依赖它），
 *      且建议项确实被 `isKnownFlag` 认识（不会建议一个本 CLI 并不认识的旗标）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlagSuggestion } from '../../src/cli/flagSuggestion.js';
import { CliFlagTable } from '../../src/cli/cliFlagTable.js';

/** 仓库根（dist/tests/unit → 上溯三级）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 判据用的真旗标集合（与生产同一来源，避免测试自己造一份会漂移的清单）。 */
const KNOWN = CliFlagTable.knownFlagNames();

/**
 * 断言某个手滑输入给出指定建议。
 * @param token 用户敲下的 token
 * @param expected 期望的建议旗标
 */
function expectSuggest(token: string, expected: string): void {
  assert.strictEqual(FlagSuggestion.suggest(token, KNOWN), expected, `${token} 应建议 ${expected}`);
}

test('① 认得出手滑：换位 / 少字母 / 多字母 / 少一个横线', () => {
  // 相邻换位（最典型的手滑形态）：普通 Levenshtein 距离是 2，会被阈值挡掉 ⇒ 必须用 OSA。
  expectSuggest('--modle', '--model');
  expectSuggest('--jsno', '--json');
  expectSuggest('--prot', '--port');
  // 少一个字母 / 多一个字母
  expectSuggest('--approvl', '--approval');
  expectSuggest('--workpace', '--workspace');
  expectSuggest('--ports', '--port');
  // 少打一个横线：归一化剥掉全部前导 `-`，故应精确命中
  expectSuggest('-model', '--model');
});

test('② 不瞎猜（负对照）：毫无关系的名字一律不给建议', () => {
  // 这条是本次改动**最重要**的判据：宁可没有建议，也不要猜错。
  for (const junk of ['--zzzzzz', '--definitely-not-a-flag', '--qqqqqqqq', '--xyzzy']) {
    assert.strictEqual(
      FlagSuggestion.suggest(junk, KNOWN),
      null,
      `${junk} 不应给出任何建议（猜错比不猜更糟）`,
    );
  }
  // **实测踩过的具体反例**：只按编辑距离时 `--work`（4 字符）会命中距离 1 的 `--fork`。
  // 首字符一致这条规则就是为了挡掉它——`--work` 与 `--fork` 首字母不同，属于"另一个词"。
  assert.strictEqual(
    FlagSuggestion.suggest('--work', KNOWN),
    null,
    '--work 不得被建议成 --fork（首字符不同 ⇒ 不猜）',
  );
  // 少掉首字母的输入同样不猜（`--odel` 不该猜成 `--model`）
  assert.strictEqual(FlagSuggestion.suggest('--odel', KNOWN), null, '首字符不一致不猜');
  // 太短的名字不猜：3 个字符以下的候选空间太密
  assert.strictEqual(FlagSuggestion.suggest('--ab', KNOWN), null, '短于 3 字符不猜');
  assert.strictEqual(FlagSuggestion.suggest('--', KNOWN), null, '全横线不猜');
  assert.strictEqual(FlagSuggestion.suggest('-', KNOWN), null, '单个横线不猜');
});

test('③ 并列时闭嘴：多个候选同样近 ⇒ 返回 null 而不是随便挑', () => {
  // 合成候选集（本函数是纯函数，取 known 作参数）：`--aaac` 与 `--aaaa` / `--aaab` 距离都是 1、
  // 公共前缀都是 3 ⇒ 真并列，必须拒绝给建议。
  const tie = ['--aaaa', '--aaab'];
  assert.strictEqual(FlagSuggestion.suggest('--aaac', tie), null, '真并列不得给建议');
  // 正对照：同形但只有一个候选在阈值内 ⇒ 必须给建议（判据不是"一律不给"）
  assert.strictEqual(FlagSuggestion.suggest('--aaac', ['--aaaa', '--zzzz']), '--aaaa');
  // 短旗标整类不猜（`-h` / `-V` / `-p` 互相只差一个字母）
  assert.strictEqual(FlagSuggestion.suggest('-x', KNOWN), null, '短旗标不参与建议');
  assert.strictEqual(
    FlagSuggestion.suggest('-x', ['-h', '-V', '-p']),
    null,
    '候选里只有短旗标时也不猜',
  );
});

test('④ 前缀缩写只在唯一匹配时给出', () => {
  // `--escal` 只可能是 `--escalation`
  expectSuggest('--escal', '--escalation');
  expectSuggest('--profil', '--profile');
  // 前缀不唯一则不给建议（`--storage` 同时是 --storage-adapter 与 --storage-dir 的前缀）
  assert.strictEqual(FlagSuggestion.suggest('--storage', KNOWN), null, '前缀不唯一不得给建议');
});

test('⑤ 接线与契约：`未知旗标 <token>` 相连、无建议时文案逐字不变、建议项确实被认识', () => {
  const withGuess = FlagSuggestion.unknownFlagMessage('--modle', KNOWN);
  // 既有判据（knownFlags.test.ts ④/⑥、probesInRepo.test.ts ⑧）按这个子串断言"报错指名了真未知旗标"
  assert.match(withGuess, /未知旗标 --modle/, '必须以 `未知旗标 <token>` 相连');
  assert.match(withGuess, /你是不是想用 --model？/, '必须给出建议');
  // 无建议时文案与历史**逐字相同**（零行为回归）
  assert.strictEqual(
    FlagSuggestion.unknownFlagMessage('--definitely-not-a-flag', KNOWN),
    '未知旗标 --definitely-not-a-flag（本 CLI 不认识它；用 --help 查看全部旗标。' +
      '若 prompt 本身以 - 开头，请用 --prompt 传递或写在 `--` 之后）',
  );
  // 建议只能来自"本 CLI 认识"的集合：否则等于建议用户去踩另一个坑
  for (const token of ['--modle', '--approvl', '--escal', '-model']) {
    const guess = FlagSuggestion.suggest(token, KNOWN);
    assert.ok(guess !== null, `${token} 应有建议`);
    assert.ok(
      CliFlagTable.isKnownFlag(guess),
      `建议的 ${guess} 必须是本 CLI 认识的旗标（isKnownFlag 交叉核对）`,
    );
  }
  // 已知旗标集合非空（防这份"候选来源"被改坏后建议全体失效）
  assert.ok(KNOWN.length > 50, `已知旗标集合规模异常：${KNOWN.length}`);
});

test('⑥ 架构约束：flagSuggestion 必须是**叶子模块**（不得反向 import cli/** 兄弟）', () => {
  // 2026-10-08 实测事故：让 flagSuggestion 自己 import cliFlagTable 取清单，会把架构门禁白名单
  // 环①（argParser ↔ cliEnums ↔ cliFlagTable ↔ cliHelp）从 4 成员**撑到 5 成员** ⇒ 门禁报
  // 「新增环」并中止提交。本判据把"清单由调用方注入"这条约束钉在源码上（门禁的窄化前哨）。
  const src = readFileSync(join(REPO_ROOT, 'src', 'cli', 'flagSuggestion.ts'), 'utf8');
  const fromCli = [...src.matchAll(/from\s+'\.\/([a-zA-Z]+)\.js'/g)].map((m) => m[1]);
  assert.deepStrictEqual(
    fromCli,
    [],
    `flagSuggestion 不得 import src/cli 下的兄弟模块：${fromCli.join(', ')}`,
  );
  // 反向接线：真的有人在调用点把清单注入进去（否则它变成"永远不给建议"的死代码）
  const parser = readFileSync(join(REPO_ROOT, 'src', 'cli', 'argParser.ts'), 'utf8');
  assert.match(
    parser,
    /FlagSuggestion\.unknownFlagMessage\(arg, CliFlagTable\.knownFlagNames\(\)\)/,
    'argParser 必须在调用点注入已知旗标清单',
  );
});
