/**
 * S4（GEE Kernel v1 · ADR-0008）：级联评估判据。
 *
 * 蓝图判据（EVOLUTION_ARCH_UPGRADE_2026-10 §4 S4）：
 * - 静态失败 ⇒ spawn **调用次数 = 0**（注入计数器断言短路，不是「大概没跑」）；
 * - 静态通过 ⇒ 退出码语义与原 `VerifiableReward` **逐字一致**（不改变奖励口径）；
 * - 明细 reason 分级：`static-fail` / `verified-pass` / `verified-fail` / `unverifiable:*`；
 * - 附加：静态否决记 `verifiable=false`（不虚增势函数覆盖率）/ 短路统计 / 装配级接线。
 *
 * hermetic：真实子进程验证用本测试进程的 node 做 `--check` 语法检查（无网络、无外部依赖）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CascadeReward } from '../../src/evolution/cascadeReward.js';
import { VerifiableReward } from '../../src/evolution/verifiableReward.js';
import { RlvrController } from '../../src/evolution/rlvrController.js';
import {
  RewardCoverageMeter,
  COVERAGE_THRESHOLD,
} from '../../src/evolution/rewardCoverageMeter.js';
import type { RewardVerdict } from '../../src/evolution/rewardCoverageMeter.js';
import type { CodeCandidate } from '../../src/evolution/rlvrLoop.js';
import type { ModelPort } from '../../src/ports/model/model.js';
import type { Skill } from '../../src/skill/skill.js';
import { MoireComposer } from '../../src/skill/moireComposer.js';

/** 语法合法的候选代码（`node --check` 必绿）。 */
const GREEN_CODE = 'const add = (a, b) => a + b;\n';

/** 语法非法的候选代码（`node --check` 必红）。 */
const RED_CODE = 'const = ;\n';

/** 真实验证命令（本测试进程的 node；`%CODE_FILE%` 写入 `.js` 临时文件）。 */
const VERIFY_COMMAND = `"${process.execPath}" --check %CODE_FILE%`;

/**
 * 造代码候选。
 * @param code 候选代码
 * @param id 候选 id
 * @returns CodeCandidate
 */
function codeOf(code: string, id = 's0'): CodeCandidate {
  return { id, code };
}

/**
 * 造内层判据 + spawn 计数器（断言短路的唯一可信证据）。
 * @returns 计数器、调用记录与判据函数
 */
function countingInner(): {
  readonly calls: readonly CodeCandidate[];
  readonly inner: (candidate: CodeCandidate) => Promise<RewardVerdict>;
} {
  const calls: CodeCandidate[] = [];
  return {
    calls,
    inner: (candidate: CodeCandidate): Promise<RewardVerdict> => {
      calls.push(candidate);
      return Promise.resolve({ reward: 1, verifiable: true, reason: 'verified-pass' });
    },
  };
}

test('S4 短路判据：三条静态预检各自不过 ⇒ 内层（spawn）调用次数 = 0', async () => {
  const cases: readonly { readonly rule: string; readonly code: string }[] = [
    { rule: 'static-fail:empty', code: '// generation error\n' },
    { rule: 'static-fail:empty', code: '/* 采样占位 */\n' },
    { rule: 'static-fail:fence-unbalanced', code: 'const a = 1;\n```\n' },
    { rule: 'static-fail:forbidden:child-process', code: "import cp from 'node:child_process';\n" },
    { rule: 'static-fail:forbidden:dynamic-eval', code: 'export const f = () => eval("1+1");\n' },
    { rule: 'static-fail:forbidden:process-exit', code: 'process.exit(0);\n' },
  ];
  for (const c of cases) {
    const { calls, inner } = countingInner();
    const cascade = new CascadeReward({ inner });
    const verdict = await cascade.verify(codeOf(c.code));
    assert.deepStrictEqual(
      { reason: verdict.reason, reward: verdict.reward, verifiable: verdict.verifiable },
      { reason: c.rule, reward: 0, verifiable: false },
      `${c.rule}：静态否决必须短路且如实申报`,
    );
    assert.strictEqual(calls.length, 0, `${c.rule}：内层判据绝不能被调用（spawn 次数 = 0）`);
  }
});

test('S4 口径一致：静态通过 ⇒ 与 VerifiableReward 逐字同判（只加更早的否决，不加新的通过路径）', async () => {
  const base = VerifiableReward.verifiableVerdictForCode(() => VERIFY_COMMAND, {
    codeFileExtension: '.js',
  });
  const cascade = new CascadeReward({ inner: base });
  for (const code of [GREEN_CODE, RED_CODE]) {
    const expected = await base(codeOf(code));
    const actual = await cascade.verify(codeOf(code));
    assert.deepStrictEqual(actual, expected, `静态通过后必须与原始判据逐字一致：${code.trim()}`);
  }
  // 绿/红两侧都真实走到命令：证明确实没走短路分支。
  assert.deepStrictEqual(await cascade.verify(codeOf(GREEN_CODE)), {
    reward: 1,
    verifiable: true,
    reason: 'verified-pass',
  });
  assert.deepStrictEqual(await cascade.verify(codeOf(RED_CODE)), {
    reward: 0,
    verifiable: true,
    reason: 'verified-fail',
  });
});

test('S4 不可验证口径：命令缺失 ⇒ unverifiable:no-command（静态通过也照样如实申报）', async () => {
  const base = VerifiableReward.verifiableVerdictForCode(() => undefined);
  const cascade = new CascadeReward({ inner: base });
  const verdict = await cascade.verify(codeOf(GREEN_CODE));
  assert.deepStrictEqual(verdict, {
    reward: 0,
    verifiable: false,
    reason: 'unverifiable:no-command',
  });
});

test('S4 诚实口径：静态否决记 verifiable=false ⇒ 不虚增势函数覆盖率（覆盖率为 0 而非 1）', async () => {
  const meter = new RewardCoverageMeter();
  const cascade = new CascadeReward({
    inner: () => Promise.resolve({ reward: 1, verifiable: true, reason: 'verified-pass' }),
  });
  const reward = meter.wrap({ verify: (c: unknown) => cascade.verify(c as CodeCandidate) });
  assert.strictEqual(await reward(codeOf('// empty generation')), 0, '静态否决 → 奖励 0');
  const report = meter.report();
  assert.strictEqual(report.samples, 1);
  assert.strictEqual(report.verified, 0, '没跑过真实命令 ⇒ 不算「真实可验证判定」');
  assert.strictEqual(report.coverage, 0);
  assert.ok(report.coverage < COVERAGE_THRESHOLD, '覆盖率低于阈值口径不变');
});

test('S4 短路统计：按规则计数（省下的全量验证成本可观测，且放行者不计入短路）', async () => {
  const { calls, inner } = countingInner();
  const cascade = new CascadeReward({ inner });
  await cascade.verify(codeOf('// generation error'));
  await cascade.verify(codeOf('const a = 1;\n```\n'));
  await cascade.verify(codeOf('const a = 1;\n'));
  const stats = cascade.stats();
  assert.deepStrictEqual(stats.byRule, { empty: 1, 'fence-unbalanced': 1 });
  assert.strictEqual(stats.checked, 3);
  assert.strictEqual(stats.shortCircuited, 2);
  assert.strictEqual(calls.length, 1, '放行者才付全量验证成本');
});

test('S4 装配级接线：createRlvrEvolutionController 开 cascade 才装级联（缺省关 = 零破坏）', async () => {
  const model = {
    generate: async () => ({ text: '```js\n// generation error\n```' }),
  } as unknown as ModelPort;
  const common = {
    skills: [],
    compose: (a: Skill, b: Skill) => MoireComposer.composeByTwist(a, b),
    model,
    verifyCommand: VERIFY_COMMAND,
    verifyCodeFileExtension: '.js',
  };
  const off = RlvrController.createRlvrEvolutionController(common);
  assert.strictEqual(off.cascade, undefined, 'cascade 缺省关：装配面与现状一致');
  const on = RlvrController.createRlvrEvolutionController({ ...common, cascade: true });
  const cascade = on.cascade;
  assert.ok(cascade instanceof CascadeReward, 'cascade:true ⇒ 装配级联评估');
  // 采样器的 fail-closed 占位（`// generation error`）在级联下走短路：不 spawn、不算验过。
  assert.deepStrictEqual(await cascade.verify(codeOf('// generation error')), {
    reward: 0,
    verifiable: false,
    reason: 'static-fail:empty',
  });
  assert.strictEqual(cascade.stats().shortCircuited, 1);
});
