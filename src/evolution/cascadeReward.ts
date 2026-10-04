/**
 * 级联评估奖励（GEE Kernel v1 · ③ verify 环的成本结构，ADR-0008 / EVOLVIX_SPEC §4 F1）。
 *
 * 解决的问题：`verifyCommand` 是整条进化链上**最贵**的一步（每个候选一次子进程全量验证，
 * 单次上限 120s）。而多数「采样噪声」在**还没起子进程之前**就能被纯函数判定为不值得验证
 * （空实现 / 代码围栏不配平 / 命中红线模式）——先跑零成本预检、不过即短路，评估成本
 * 只花在真正需要跑命令的候选上。
 *
 * 级联结构（快 → 慢，短路即省全量）：
 * ```
 *   candidate ──▶ ① 静态预检（纯函数，零成本）──不过──▶ static-fail:<规则>（不 spawn）
 *                              │过
 *                              ▼
 *                 ② 真实 verifyCommand（退出码）──▶ verified-pass / verified-fail / unverifiable:*
 * ```
 *
 * **口径纪律（判据钉死，不得漂移）**：
 * - 静态**通过**时，返回值与原 `VerifiableReward` 逐字一致——本类只加「更早的否决」，不加
 *   新的通过路径（绝不把静态预检当成功依据）；
 * - 静态**否决**记为 `verifiable: false`：真实命令没跑过，「没验过」不得冒充「验过」
 *   （`RewardCoverageMeter` 的诚实口径：覆盖率只数真实判定，混入静态否决会虚增信号密度）；
 * - 静态预检是**必要条件的保守近似**，存在误杀可能（如字符串里出现 `eval(`）——这是
 *   刻意的成本/精度权衡：误杀只损失一次候选，不改变任何「通过」的语义。
 *
 * @maturity L1 — 短路与口径一致性判据钉死（spawn 次数 = 0 断言）；净省成本未实测
 * @maturityEvidence tests/unit/cascadeReward.test.ts
 */
import type { CodeCandidate } from './rlvrLoop.js';
import type { RewardVerdict } from './rewardCoverageMeter.js';
import { log } from '../util/logger.js';

/** 静态预检项：纯函数、零成本。返回 `undefined` = 通过；返回规则名 = 短路否决。 */
export type StaticCheck = (candidate: CodeCandidate) => string | undefined;

/** 一条禁用模式（红线）：`name` 进 reason 明细，`pattern` 为纯正则。 */
export interface ForbiddenPattern {
  /** 规则名（进 `static-fail:forbidden:<name>`，观测可辨）。 */
  readonly name: string;
  /** 命中即否决的模式。 */
  readonly pattern: RegExp;
}

/** 级联评估选项。 */
export interface CascadeRewardOptions {
  /** 内层判据（真实 `verifyCommand`；**只**在静态预检全部通过后才被调用）。 */
  readonly inner: (candidate: CodeCandidate) => Promise<RewardVerdict>;
  /** 静态预检项（缺省 = {@link CascadeReward.defaultChecks}）。 */
  readonly checks?: readonly StaticCheck[] | undefined;
}

/** 短路计数（观测面：省下多少次全量验证）。 */
export interface CascadeStats {
  /** 经过静态预检的候选数（含短路与被放行者）。 */
  readonly checked: number;
  /** 被静态预检短路（未付全量验证成本）的候选数。 */
  readonly shortCircuited: number;
  /** 按规则名的短路次数（频次可辨，供调规则）。 */
  readonly byRule: Readonly<Record<string, number>>;
}

/** 级联评估奖励：静态预检（纯函数）→ 真实可验证奖励，短路即省全量。 */
export class CascadeReward {
  /**
   * 红线模式（命中即否决，**不 spawn**）。
   *
   * 依据 ADR-0008 的边界「不进化代码与权重」：一个技能候选若自行起子进程、动态求值字符串
   * 或直接终止宿主进程，它就不是「可复用能力」而是「未受管的代码执行」——这类候选不该
   * 花验证成本，也不该有机会靠「命令恰好退出 0」进入晋升路径。
   */
  public static readonly FORBIDDEN: readonly ForbiddenPattern[] = [
    { name: 'child-process', pattern: /\b(?:node:)?child_process\b/ },
    { name: 'dynamic-eval', pattern: /(?:\beval|new\s+Function)\s*\(/ },
    { name: 'process-exit', pattern: /\bprocess\s*\.\s*exit\s*\(/ },
  ];

  /** 内层判据（真实验证）。 */
  private readonly inner: (candidate: CodeCandidate) => Promise<RewardVerdict>;
  /** 静态预检链（按序短路）。 */
  private readonly checks: readonly StaticCheck[];
  /** 已检查候选数。 */
  private readonly byRule = new Map<string, number>();
  /** 累计检查数。 */
  private checked = 0;
  /** 累计短路数。 */
  private shortCircuited = 0;

  /**
   * @param opts 内层判据与静态预检链（缺省用默认三检）
   */
  public constructor(opts: CascadeRewardOptions) {
    this.inner = opts.inner;
    this.checks = opts.checks ?? CascadeReward.defaultChecks();
  }

  /** 默认静态预检链：非空 → 围栏配平 → 红线模式（先便宜后精细，零成本）。
   * @returns 静态预检项列表（按序短路）
   */
  public static defaultChecks(): readonly StaticCheck[] {
    return [CascadeReward.nonEmpty, CascadeReward.balancedFences, CascadeReward.noForbiddenPattern];
  }

  /**
   * 非空（去注释后仍有内容）：空串与「只有注释」的生成物是采样失败的占位（如
   * `// empty generation`）——它们对 `node --check` 之类命令**恒绿**，是最典型的假绿来源。
   * @param candidate 代码候选
   * @returns 通过为 undefined；否则规则名
   */
  public static nonEmpty(candidate: CodeCandidate): string | undefined {
    const stripped = candidate.code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    return stripped.trim().length === 0 ? 'empty' : undefined;
  }

  /**
   * 围栏配平：代码正文里残留奇数个 Markdown 围栏行，说明抽取区域本身是坏的
   * （抽取失败/嵌套围栏），继续验证只是烧验证成本。
   * @param candidate 代码候选
   * @returns 通过为 undefined；否则规则名
   */
  public static balancedFences(candidate: CodeCandidate): string | undefined {
    const fences = candidate.code.match(/^[ \t]*```/gm);
    return (fences?.length ?? 0) % 2 === 0 ? undefined : 'fence-unbalanced';
  }

  /**
   * 红线模式（{@link CascadeReward.FORBIDDEN}）：命中即否决，绝不 spawn。
   * @param candidate 代码候选
   * @returns 通过为 undefined；否则 `forbidden:<规则名>`
   */
  public static noForbiddenPattern(candidate: CodeCandidate): string | undefined {
    for (const rule of CascadeReward.FORBIDDEN) {
      if (rule.pattern.test(candidate.code)) return `forbidden:${rule.name}`;
    }
    return undefined;
  }

  /**
   * 级联判据：静态预检 → （全过才）真实验证。
   * @param candidate 代码候选
   * @returns 判据明细（静态否决 = `static-fail:<规则>` 且 `verifiable: false`）
   */
  public async verify(candidate: CodeCandidate): Promise<RewardVerdict> {
    this.checked++;
    for (const check of this.checks) {
      const rule = check(candidate);
      if (rule === undefined) continue;
      this.shortCircuited++;
      this.byRule.set(rule, (this.byRule.get(rule) ?? 0) + 1);
      try {
        log.debug('evolution.cascade.static-fail', { rule, id: candidate.id });
      } catch {
        // 观测尽力而为：不影响短路判定
      }
      return { reward: 0, verifiable: false, reason: `static-fail:${rule}` };
    }
    return this.inner(candidate);
  }

  /**
   * 短路统计（观测面）。
   * @returns 检查数 / 短路数与按规则明细
   */
  public stats(): CascadeStats {
    return {
      checked: this.checked,
      shortCircuited: this.shortCircuited,
      byRule: Object.fromEntries(this.byRule),
    };
  }
}
