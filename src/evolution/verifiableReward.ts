/**
 * 可验证奖励（U4 升格 RLVR 的核心）。
 *
 * 把「编译绿 / 测试绿 / eval 套件通过率」这类**客观可验证信号**封装成进化门禁可用的
 * 奖励函数，取代原启发式结构相似度奖励。fail-closed：任何异常 → 奖励 0（绝不假通过）。
 *
 * 零运行时依赖（仅 node:child_process 起子进程验证）。
 *
 * @maturity L1 — 可验证奖励结构在；势函数覆盖率未知（T5 待体检）
 * @maturityEvidence tests/unit/rlvr.test.ts
 */
import { spawnSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candidate } from '../ports/runtime/evolution.js';
import {
  FailClosedEvolutionGate,
  type FailClosedEvolutionGateOptions,
} from './failClosedEvolutionGate.js';
import type { BenchmarkFn } from './failClosedEvolutionGate.js';
import type { CodeCandidate } from './rlvrLoop.js';
import type { RewardVerdict } from './rewardCoverageMeter.js';

/**
 * VerifiableRewardFn —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class VerifiableReward {
  /**
   * 由「命令退出码」构造奖励：命令退出 0 → 1，否则 0。
   * `commandFor` 从候选元信息抽取待验证命令（如 `tsc --noEmit` / `node test.js`），
   * `cwdFor` 抽取工作目录。命令缺失 → 0。
   */
  public static verifiableRewardFromCommand(
    commandFor: (candidate: Candidate) => string | undefined,
    cwdFor?: (candidate: Candidate) => string | undefined,
  ): VerifiableRewardFn {
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
  public static verifiableRewardFromEvalRunner(
    runner: (candidate: Candidate) => Promise<{ passed: number; total: number }>,
  ): VerifiableRewardFn {
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

  /** 把可验证奖励适配成进化门禁的 `BenchmarkFn`（fail-closed：异常 → 0）。 */
  public static benchmarkFromVerifiableReward(reward: VerifiableRewardFn): BenchmarkFn {
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
  public static createVerifiableGate(
    reward: VerifiableRewardFn,
    opts: Omit<FailClosedEvolutionGateOptions, 'benchmark'> = {},
  ): FailClosedEvolutionGate {
    return new FailClosedEvolutionGate({
      ...opts,
      benchmark: VerifiableReward.benchmarkFromVerifiableReward(reward),
    });
  }

  /**
   * (U4 桥) 代码级可验证奖励：把 `verifiableReward` 接到 `RlvrLoop`（后者作用在 `CodeCandidate` 上）。
   *
   * - `commandFor` 从代码候选抽取待验证命令（如 `npx tsc --noEmit %CODE_FILE%`）；命令缺失 → 0。
   * - 命令中含 `%CODE_FILE%` 占位符时，先把 `candidate.code` 写入临时代码文件（扩展名由
   *   `codeFileExtension` 指定，默认 `.ts`）、把路径代入命令，使「编译/测试这段代码」成为真实
   *   可验证信号（这就是 RLVR 的奖励来源：客观编译/测试绿度）。验证结束即删除临时文件。
   *
   *   扩展名必须与命令的语言匹配：如 `node --check %CODE_FILE%` 验证 JS 代码须传 `.js`——
   *   Node 22.18 起才默认解析 `.ts`，把 JS 代码写进 `.ts` 文件会得到与代码质量无关的假红。
   * - 退出码 0 → 1（绿），否则 0。异常 → 0（fail-closed，绝不假通过）。
   *
   * 这一道桥正是 U4 两模块（`verifiableReward` 的 skill 型奖励 ↔ `RlvrLoop` 的代码型采样）此前
   * 互不相通的根因——补齐后 `RlvrLoop` 才真正由「可验证奖励」驱动。
   */
  public static verifiableRewardForCode(
    commandFor: (candidate: CodeCandidate) => string | undefined,
    opts: VerifiableCodeRewardOptions = {},
  ): (candidate: CodeCandidate) => Promise<number> {
    const verdictFor = VerifiableReward.verifiableVerdictForCode(commandFor, opts);
    return async (candidate) => (await verdictFor(candidate)).reward;
  }

  /**
   * (T5.1 桥) 同上，但返回**判据明细**（`reward` + `verifiable` + `reason`）而非裸数值。
   *
   * 为什么必须有这一版：`verifiableRewardForCode` 把「真判负」与「没能验证」（命令缺失 /
   * 临时文件写入失败 / spawn 抛错）都压成同一个 0，调用方无从统计**势函数覆盖率**。
   * 明细版把两者显式分开，供 `RewardCoverageMeter` 记账（覆盖率体检的数据源）；
   * `verifiableRewardForCode` 由本函数收口，故「奖励语义」只有一处实现，不会双份漂移。
   *
   * @param commandFor 从代码候选抽取待验证命令（可含 `%CODE_FILE%` 占位符）
   * @param opts 工作目录抽取器与占位符（可选）
   * @returns 候选 → 判据明细（fail-closed：任何未能验证的情况 verifiable=false）
   */
  public static verifiableVerdictForCode(
    commandFor: (candidate: CodeCandidate) => string | undefined,
    opts: VerifiableCodeRewardOptions = {},
  ): (candidate: CodeCandidate) => Promise<RewardVerdict> {
    const token = opts.codeFileToken ?? '%CODE_FILE%';
    const extension = opts.codeFileExtension ?? '.ts';
    return async (candidate) => {
      const cmd = commandFor(candidate);
      if (cmd === undefined) {
        return { reward: 0, verifiable: false, reason: 'unverifiable:no-command' };
      }
      let command = cmd;
      let tmp: string | undefined;
      if (command.includes(token)) {
        tmp = join(
          tmpdir(),
          `omni-rlvr-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`,
        );
        try {
          writeFileSync(tmp, candidate.code, 'utf8');
        } catch (err) {
          try {
            unlinkSync(tmp);
          } catch {
            // 半写文件清不掉就交给系统临时目录策略
          }
          return {
            reward: 0,
            verifiable: false,
            reason: `unverifiable:write-error:${String(err)}`,
          };
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
      } catch (err) {
        return { reward: 0, verifiable: false, reason: `unverifiable:spawn-error:${String(err)}` };
      } finally {
        if (tmp !== undefined) {
          try {
            unlinkSync(tmp);
          } catch {
            // 清理失败不影响判据（fail-closed 已按退出码定论；垃圾文件交给系统临时目录策略）
          }
        }
      }
      return status === 0
        ? { reward: 1, verifiable: true, reason: 'verified-pass' }
        : { reward: 0, verifiable: true, reason: 'verified-fail' };
    };
  }
}

/** 可验证奖励：候选 → 0..1。1 表示「绿」（编译/测试通过），0 表示失败。 */
export type VerifiableRewardFn = (candidate: Candidate) => Promise<number>;

/** 代码级可验证奖励的公共选项（`verifiableRewardForCode` / `verifiableVerdictForCode` 共用）。 */
export interface VerifiableCodeRewardOptions {
  /** 工作目录抽取器（可选；缺省继承当前进程 cwd）。 */
  readonly cwdFor?: (candidate: CodeCandidate) => string | undefined;
  /** 命令中的代码路径占位符（默认 `%CODE_FILE%`）。 */
  readonly codeFileToken?: string;
  /**
   * 临时代码文件的扩展名（默认 `.ts`）。必须与验证命令的语言匹配：
   * `npx tsc --noEmit %CODE_FILE%` 用默认 `.ts`；`node --check %CODE_FILE%` 验证 JS 代码传 `.js`。
   */
  readonly codeFileExtension?: string | undefined;
}
