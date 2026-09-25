/**
 * CLI 取值旗标登记护栏（E2 顺带修的机制洞）。
 *
 * `ArgParser.collectPositional` 靠 `VALUE_FLAGS` 判断「某 token 是旗标的取值」还是「位置参数」；
 * 一旦某个**消费取值**的旗标漏登记，它的取值就会被当成位置参数并回填进 `prompt`
 * （实测：E3 新增的 `--rlvr-verify` 等五个旗标漏登记 → `--rlvr-verify "node --check f.ts"`
 * 会把整条命令塞进 prompt）。
 *
 * 本护栏把该不变量机器化：凡 `FLAG_TABLE` 中「消费取值」（返回 1，或对占位取值抛错）的旗标，
 * 必须出现在 `VALUE_FLAGS` 里；新增旗标漏登记即红，无需人工记忆。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliDefaults, ArgParser } from '../../src/cli/argParser.js';
import type { CliArgs } from '../../src/cli/argParser.js';
import { FLAG_TABLE, VALUE_FLAGS } from '../../src/cli/cliFlagTable.js';

/** 占位取值：非空且非数字，能触发枚举/数字旗标的校验分支。 */
const PLACEHOLDER = 'PLACEHOLDER_VALUE';

test('CLI 机制护栏：所有消费取值的旗标都已在 VALUE_FLAGS 登记', () => {
  const missing: string[] = [];
  for (const [flag, apply] of Object.entries(FLAG_TABLE)) {
    const probe: CliArgs = { ...CliDefaults };
    let consumed: boolean;
    try {
      consumed = apply(probe, [flag, PLACEHOLDER], 0) === 1;
    } catch {
      // 占位取值被判非法（如枚举白名单）→ 该旗标确实消费取值，记为消费型。
      consumed = true;
    }
    if (consumed && !VALUE_FLAGS.has(flag)) {
      missing.push(flag);
    }
  }
  assert.deepStrictEqual(
    missing,
    [],
    `以下消费取值的旗标漏登记 VALUE_FLAGS（其取值会被误判为位置参数并入 prompt）：${missing.join(', ')}`,
  );
});

test('CLI 回归：取值旗标的取值不得被并入 prompt（新增旗标 + 漏登记的 RLVR 旗标）', () => {
  const args = ArgParser.parseArgs([
    '--evolution-rlvr',
    '--rlvr-verify',
    'node --check candidate.ts',
    '--rlvr-samples',
    '2',
    '--a2a',
    '--a2a-port',
    '8790',
    '--a2a-peer',
    'http://127.0.0.1:8790/a2a',
    '--a2a-transport',
    'ws',
    '--prompt',
    'real task',
  ]);
  assert.ok(args !== undefined, '提供了 --prompt，解析不应返回 undefined');
  assert.strictEqual(args.rlvrVerify, 'node --check candidate.ts');
  assert.strictEqual(args.rlvrSamples, 2);
  assert.strictEqual(args.a2a, true);
  assert.strictEqual(args.a2aPort, 8790);
  assert.strictEqual(args.a2aPeer, 'http://127.0.0.1:8790/a2a');
  assert.strictEqual(args.a2aTransport, 'ws');
  assert.strictEqual(args.prompt, 'real task', '取值旗标的取值不得被并入 prompt');
});

test('CLI 校验：--a2a-transport 非法取值 fail-closed 抛错', () => {
  assert.throws(
    () => ArgParser.parseArgs(['--a2a', '--a2a-transport', 'quic', '--prompt', 'x']),
    /非法参数值/,
    '枚举旗标必须显式校验，不得裸强转',
  );
});
