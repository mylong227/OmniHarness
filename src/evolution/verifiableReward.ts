/**
 * 可验证奖励（U4 升格 RLVR 的核心）。
 *
 * 把「编译绿 / 测试绿 / eval 套件通过率」这类**客观可验证信号**封装成进化门禁可用的
 * 奖励函数，取代原启发式结构相似度奖励。fail-closed：任何异常 → 奖励 0（绝不假通过）。
 *
 * 零运行时依赖（仅 node:child_process 起子进程验证）。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candidate } from '../ports/evolution.js';
import type { Benchmark } from './evolutionGate.js';
import type { CodeCandidate } from './rlvrLoop.js';
import { FailClosedEvolutionGate, type FailClosedEvolutionGateOptions } from './evolutionGate.js';

/** 可验证奖励：候选 → 0..1。1 表示「绿」（编译/测试通过），0 表示失败。 */
export type VerifiableReward = (candidate: Candidate) => Promise<number>;

/**
 * 由「命令退出码」构造奖励：命令退出 0 → 1，否则 0。
 * `commandFor` 从候选元信息抽取待验证命令（如 `tsc --noEmit` / `node test.js`），
 * `cwdFor` 抽取工作目录。命令缺失 → 0。
 */
export function verifiableRewardFromCommand(
  commandFor: (candidate: Candidate) => string | undefined,
  cwdFor?: (candidate: Candidate) => string | undefined,
): VerifiableReward {
  return async (candidate) => {
    const cmd = commandFor(candidate);
    if (cmd === undefined) return 0;
    let status = -1;
    try {
      const r = spawnSync(cmd, [], {
        cwd: cwdFor?.(candidate),
        encoding: 'utf8',
        shell: true,
        timeout: 120_000,
      });
      status = r.status ?? -1;
    } catch {
      status = -1;
    }
    return status === 0 ? 1 : 0;
  };
}

/**
 * 由「eval 套件运行器」构造奖励：运行器返回 { passed, total }，奖励 = passed/total。
 * 运行器由调用方注入（决定如何把候选纳入 suite），保持解耦、可测。
 */
export function verifiableRewardFromEvalRunner(
  runner: (candidate: Candidate) => Promise<{ passed: number; total: number }>,
): VerifiableReward {
  return async (candidate) => {
    try {
      const r = await runner(candidate);
      if (r.total <= 0) return 0;
      return r.passed / r.total;
    } catch {
      return 0;
    }
  };
}

/** 把可验证奖励适配成进化门禁的 `Benchmark`（fail-closed：异常 → 0）。 */
export function benchmarkFromVerifiableReward(reward: VerifiableReward): Benchmark {
  return async (candidate) => {
    try {
      return await reward(candidate);
    } catch {
      return 0;
    }
  };
}

/**
 * 用可验证奖励构造 fail-closed 进化门禁（RLVR 就绪）：
 * 候选必须过「可验证奖励 ≥ 基线 + minGain」且安全通过才晋升。
 */
export function createVerifiableGate(
  reward: VerifiableReward,
  opts: Omit<FailClosedEvolutionGateOptions, 'benchmark'> = {},
): FailClosedEvolutionGate {
  return new FailClosedEvolutionGate({
    ...opts,
    benchmark: benchmarkFromVerifiableReward(reward),
  });
}

/**
 * (U4 桥) 代码级可验证奖励：把 `verifiableReward` 接到 `RlvrLoop`（后者作用在 `CodeCandidate` 上）。
 *
 * - `commandFor` 从代码候选抽取待验证命令（如 `npx tsc --noEmit %CODE_FILE%`）；命令缺失 → 0。
 * - 命令中含 `%CODE_FILE%` 占位符时，先把 `candidate.code` 写入临时 `.ts` 文件、把路径代入命令，
 *   使「编译/测试这段代码」成为真实可验证信号（这就是 RLVR 的奖励来源：客观编译/测试绿度）。
 * - 退出码 0 → 1（绿），否则 0。异常 → 0（fail-closed，绝不假通过）。
 *
 * 这一道桥正是 U4 两模块（`verifiableReward` 的 skill 型奖励 ↔ `RlvrLoop` 的代码型采样）此前
 * 互不相通的根因——补齐后 `RlvrLoop` 才真正由「可验证奖励」驱动。
 */
export function verifiableRewardForCode(
  commandFor: (candidate: CodeCandidate) => string | undefined,
  opts: {
    readonly cwdFor?: (candidate: CodeCandidate) => string | undefined;
    readonly codeFileToken?: string;
  } = {},
): (candidate: CodeCandidate) => Promise<number> {
  const token = opts.codeFileToken ?? '%CODE_FILE%';
  return async (candidate) => {
    const cmd = commandFor(candidate);
    if (cmd === undefined) return 0;
    let command = cmd;
    if (command.includes(token)) {
      const tmp = join(
        tmpdir(),
        `omni-rlvr-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
      );
      try {
        writeFileSync(tmp, candidate.code, 'utf8');
      } catch {
        return 0;
      }
      command = command.split(token).join(tmp);
    }
    let status = -1;
    try {
      const r = spawnSync(command, [], {
        cwd: opts.cwdFor?.(candidate),
        encoding: 'utf8',
        shell: true,
        timeout: 120_000,
      });
      status = r.status ?? -1;
    } catch {
      status = -1;
    }
    return status === 0 ? 1 : 0;
  };
}
