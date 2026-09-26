/**
 * 旗标守卫单测（`FlagGuard`）。
 *
 * 动因是两次真实事故：驼峰旗标把「产品口径 4 候选」静默跑成单候选（白花一次付费 pilot）；
 * 同族风险是判分侧信任闸 `--gold-control` / `--gold-report` 拼错后**静默失效、报告照常出分**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlagGuard } from '../../src/util/flagGuard.js';

test('knownFlagsOf：只认三种真正被解析的写法（含注释/字符串里的旗标不算）', () => {
  const src = [
    "const x = arg('--best-of-n');",
    "const y = process.argv.includes('--self-test');",
    "const z = process.argv.indexOf('--gold-control');",
    '// 注释里提到的 --not-a-flag 不算（它没有被解析）',
    "const url = 'https://api.deepseek.com/v1';",
  ].join('\n');
  const known = FlagGuard.knownFlagsOf(src);
  assert.deepEqual([...known].sort(), ['--best-of-n', '--gold-control', '--self-test']);
});

test('knownFlagsOf：扫不到任何旗标 ⇒ 抛错（解析写法变更时绝不静默放行一切）', () => {
  assert.throws(() => FlagGuard.knownFlagsOf('const x = 1;\n'), /解析写法可能已变/);
});

test('unknownFlags：抓出未知旗标、去重、支持 `--x=1` 形态、忽略非旗标参数', () => {
  const known = new Set(['--best-of-n', '--dry-run']);
  assert.deepEqual(
    FlagGuard.unknownFlags(
      ['--best-of-N', '4', '--dry-run', '--best-of-N', '--foo=1', 'instances.txt'],
      known,
    ),
    ['--best-of-N', '--foo'],
    '大小写不同即视为未知；=value 取值前的名字；位置参数不管',
  );
  assert.deepEqual(FlagGuard.unknownFlags(['--best-of-n', '4'], known), []);
});

test('unknownFlagMessage：给「大小写敏感」的就近提示，并列出已支持旗标', () => {
  const known = new Set(['--best-of-n', '--self-test']);
  const msg = FlagGuard.unknownFlagMessage(['--best-of-N'], known);
  assert.match(msg, /未知旗标：--best-of-N/);
  assert.match(msg, /是否想写 --best-of-n？大小写敏感/);
  assert.match(msg, /已支持：--best-of-n --self-test/);
  // 完全不像的旗标不给误导致提示
  assert.ok(!/是否想写/.test(FlagGuard.unknownFlagMessage(['--totally-unknown'], known)));
});
