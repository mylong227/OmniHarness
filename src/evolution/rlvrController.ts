/**
 * RLVR 进化控制器组合器（U4 升格的实质落点）。
 *
 * 把三段原本孤立的能力钉成一条真闭环：
 *   1. TwistDiscoveryEngine（燧-1 莫尔组合，有界发现候选技能）
 *   2. FailClosedEvolutionGate（fail-closed 门禁，可注入「可验证奖励」基准）
 *   3. RlvrLoop（StarPO sample-filter-replay：模型采样代码变体 → 可验证奖励打分 → 绿样本进回放缓冲）
 *
 * 关键桥接：U4 两个孤儿模块（`verifiableReward` 的 skill 型奖励 ↔ `RlvrLoop` 的代码型采样）
 * 通过 `verifiableRewardForCode` 接通——RLVR 的奖励来自「把候选代码写入临时文件后真实编译/测试绿度」，
 * 而非 LLM 主观评判或结构启发式。过门禁的候选还需 RLVR 阶段产生「绿」样本才晋升（fail-closed 否决）。
 *
 * T5 合流（本文件新增）：晋升**不再是门禁直通**——过门禁 + 有绿样本的候选还要过
 * `PromotionAdmission`（多样性闸 → 退火接受），并受 `RewardCoverageMeter` 的**势函数覆盖率
 * fail-closed 闸**约束（覆盖率低于阈值即整轮不晋升，见 `honestNote` 的降级口径）；
 * 每轮把覆盖率体检 / 准入明细 / 失败模式挖掘提案输出为 `evolution.rlvr.*` 观测行。
 *
 * 零第三方依赖；模型采样器 fail-closed（生成失败 → 该样本不参与回放）。
 *
 * @maturity L1 — RLVR 闭环在；Echo Trap 防护未证
 * @maturityEvidence tests/unit/evolutionRlvr.test.ts
 */
import type { Candidate } from '../ports/runtime/evolution.js';
import type { ModelPort } from '../ports/model/model.js';
import type { Skill, MoireOptions } from '../skill/skill.js';
import type { Benchmark } from './failClosedEvolutionGate.js';
import { moireEnergy } from './benchmark.js';
import { FailClosedEvolutionGate } from './failClosedEvolutionGate.js';
import { TwistDiscoveryEngine } from './twistDiscoveryEngine.js';
import { EvolutionControllerImpl } from './evolutionControllerImpl.js';
import type { EvolutionController, PromotionVerdict } from '../ports/runtime/evolution.js';
import { RlvrLoop, InMemoryReplayBuffer } from './rlvrLoop.js';
import type { RlvrSampler, ReplayBuffer, CodeCandidate } from './rlvrLoop.js';
import { verifiableVerdictForCode } from './verifiableReward.js';
import { RewardCoverageMeter, COVERAGE_THRESHOLD } from './rewardCoverageMeter.js';
import type { RewardCoverageReport } from './rewardCoverageMeter.js';
import { PromotionAdmission } from './promotionAdmission.js';
import type { AdmissionResult } from './promotionAdmission.js';
import { log } from '../util/logger.js';
import { at } from '../util/arrayAt.js';

/**
 * RlvrController 相关纯函数工具（C7 收口：原顶层内部函数迁入）。
 */
export class RlvrController {
  /**
   * 从进化候选抽取 RLVR prompt（描述该技能应实现什么）。
   * @param c Candidate
   * @returns string
   */
  public static promptForCandidate(c: Candidate): string {
    const intent = (c.skill.instructions ?? '').slice(0, 240);
    return `Implement a reusable capability named "${c.skill.name}". Intent: ${intent}`;
  }
}

/** 构造选项。 */
export interface RlvrEvolutionOptions {
  /** 候选技能池（供燧-1 组合发现）。 */
  readonly skills: readonly Skill[];
  /** 莫尔组合算子（通常注入 skillRegistry.composeByTwist）。 */
  readonly compose: (a: Skill, b: Skill, opts?: MoireOptions) => Skill;
  /** 代码采样模型（生成 RLVR 候选代码变体）。 */
  readonly model: ModelPort;
  /** 发现预算上限（默认 12）。 */
  readonly maxCandidates?: number | undefined;
  /** 每 prompt 采样数（默认 8）。 */
  readonly samplesPerPrompt?: number | undefined;
  /** RLVR 最低保留阈值（默认 0：仅保留 reward>0 的绿样本）。 */
  readonly minReward?: number | undefined;
  /**
   * 候选代码验证命令（含 `%CODE_FILE%` 占位符，运行时会替换为临时文件路径）。
   * 如 `npx tsc --noEmit %CODE_FILE%`。缺省则 RLVR 奖励恒 0（无样本进回放，fail-closed 安全）。
   */
  readonly verifyCommand?: string | undefined;
  /**
   * 验证临时文件的扩展名（默认 `.ts`，透传 `verifiableVerdictForCode`）。
   * 必须与验证命令的语言匹配：`node --check %CODE_FILE%` 验证 JS 代码须传 `.js`
   * （Node 22.18 起才默认解析 `.ts`，扩展名错配会得到与代码质量无关的假红）。
   */
  readonly verifyCodeFileExtension?: string | undefined;
  /** 能力场边长（透传燧-1）。 */
  readonly fieldSize?: number | undefined;
  /** 门禁基准（skill 级 0..1；缺省 fail-closed 0 → 无候选晋升，安全旁路）。 */
  readonly gateBenchmark?: Benchmark | undefined;
  /** 门禁须超过基线的最小增益（默认 0.05，透传 `FailClosedEvolutionGate`）。 */
  readonly minGain?: number | undefined;
  /**
   * 晋升准入器（多样性闸 + 退火接受 + 失败模式挖掘）。缺省构造保守默认
   * （`DiversityGuard` 指纹配额 2 / `AnnealedAcceptance` 种子 20260913 / 挖掘阈值 3）。
   */
  readonly admission?: PromotionAdmission | undefined;
  /**
   * 势函数覆盖率下限（默认 {@link COVERAGE_THRESHOLD} = 0.6）：本轮的 RLVR 判定覆盖率低于
   * 该线即**整轮不晋升**（fail-closed 保守处理；诚实降级口径见 `honestNote`）。
   */
  readonly minCoverage?: number | undefined;
  /** 晋升回调。 */
  readonly onPromote?: ((candidate: Candidate) => void) | undefined;
  /** 任务末自动进化（默认 false）。 */
  readonly autoRun?: boolean | undefined;
}

/** 一轮 RLVR 闭环的体检报告（覆盖率 / 准入 / 提案）。 */
export interface RlvrCycleReport {
  /** 本轮门禁裁决的候选总数。 */
  readonly candidates: number;
  /** 本轮最终晋升数（已过门禁 + RLVR + 准入 + 覆盖率闸）。 */
  readonly promoted: number;
  /** 本轮候选总数 − 晋升数（含门禁/RLVR/准入/覆盖率各级否决）。 */
  readonly rejected: number;
  /** 势函数覆盖率（真实可验证判定 / 样本数，0..1）。 */
  readonly coverage: number;
  /** 覆盖率诚实表述（低于阈值时为显式降级措辞）。 */
  readonly honestNote: string;
  /** 准入后种群去重率。 */
  readonly distinctRatio: number;
  /** 多样性塌缩告警（Echo Trap 风险）。 */
  readonly collapsed: boolean;
  /** 准入层当前退火温度（单调不升）。 */
  readonly temperature: number;
  /** 准入层累计失败记录数（失败模式挖掘的输入规模）。 */
  readonly failures: number;
  /** 失败模式挖掘产出的改进提案摘要（可为空）。 */
  readonly proposals: readonly string[];
}

/** 返回包：控制器 + 回放缓冲（供后续策略更新/观测绿样本）+ 体检报告读取口。 */
export interface RlvrEvolutionBundle {
  readonly controller: EvolutionController;
  readonly buffer: ReplayBuffer;
  /** 最近一轮闭环体检报告；尚未跑过任何一轮时返回 undefined。 */
  readonly report: () => RlvrCycleReport | undefined;
}

/** 从代码块/文本抽取首个 ```lang ... ``` 代码，否则返回原文。 */
export function extractCodeFence(text: string): string {
  const m = text.match(/```[^\n]*\n([\s\S]*?)```/);
  if (m !== null) return at(m, 1).trim();
  return text.trim();
}

/** 模型后端 RLVR 采样器：对第 index 个候选调用模型生成代码变体（fail-closed：失败返回伪样本）。 */
export function modelRlvrSampler(model: ModelPort, samplesPerPrompt: number): RlvrSampler {
  return {
    sample(
      prompt: string,
      index: number,
    ): CodeCandidate | undefined | Promise<CodeCandidate | undefined> {
      if (index >= samplesPerPrompt) return undefined;
      return (async (): Promise<CodeCandidate> => {
        try {
          const out = await model.generate({
            messages: [
              {
                role: 'user',
                content: `Write code only (no prose, no explanation) implementing:\n${prompt}`,
              },
            ],
            tools: [],
          });
          const code = extractCodeFence(out.text ?? '');
          return {
            id: `s${index}`,
            code: code.length > 0 ? code : '// empty generation',
            meta: { prompt },
          };
        } catch {
          // fail-closed：生成失败 → 伪样本（reward 0，不进回放），不中止整轮。
          return { id: `s${index}`, code: '// generation error', meta: { prompt } };
        }
      })();
    },
  };
}

/**
 * 默认门禁基准确的能力场边长。
 *
 * **为什么是 64（原为写死的 32，已知缺陷）**：`moireEnergy` 的判据「单技能 ≈0.28 / 组合 ≈0.45+」
 * 只在 **n=64** 成立——这正是 `moireComposer` 自身的默认场边长（`fieldSize ?? 64`）、两个既有门禁
 * 测试（`evolutionGate` / `evolutionIntegration`）所用的 N，也是 `benchmark.ts` 文档所载的实测量级。
 * 写死 32 时组合技能仅 ≈0.041、增益 ≈0.033（< 默认 minGain 0.05）→ **默认门禁恒不通过、RLVR 阶段
 * 永远到不了**（「端到端未开」的第二块拼图）。此处改为与全局规范尺度一致，而非调整度量本身或阈值。
 */
const DEFAULT_MOIRE_FIELD_SIZE = 64;

/**
 * RLVR 闭环控制器（晋升路径的最后一道闸）：内层跑「发现 → 门禁 → RLVR sample-filter-replay」，
 * 本类再把放行裁决依次送过 **多样性闸 → 退火接受 → 势函数覆盖率闸**，只有全过者才触发
 * `onPromote`；每轮输出体检报告（覆盖率 / 准入 / 提案）到 `evolution.rlvr.*` 观测行。
 *
 * 为什么必须由本类（而非内层）触发 `onPromote`：内层的晋升回调发生在门禁/RLVR 通过的那一刻，
 * 若把回调直接交给内层，准入两级闸就只是「事后观测」——本类持回调、内层不持，闸才真正在路径上。
 *
 * fail-closed：只做减法（绝不把未过的候选改成晋升）；覆盖率低于阈值即整轮不晋升。
 */
export class RlvrEvolutionController implements EvolutionController {
  /** 任务末自动进化标志（透传内层，真实控制 Agent 是否跑本轮）。 */
  public readonly autoRun: boolean;
  /** 内层控制器（发现 → 门禁 → RLVR 阶段）。 */
  private readonly inner: EvolutionController;
  /** 晋升准入器（多样性闸 + 退火接受 + 失败挖掘）。 */
  private readonly admission: PromotionAdmission;
  /** 覆盖率计量器（包装 RLVR 可验证奖励，逐样本记判据明细）。 */
  private readonly meter: RewardCoverageMeter;
  /** 势函数覆盖率下限（低于即整轮不晋升）。 */
  private readonly minCoverage: number;
  /** 真实晋升回调（仅准入全过者触发）。 */
  private readonly onPromote?: ((candidate: Candidate) => void) | undefined;
  /** 最近一轮体检报告。 */
  private lastReport: RlvrCycleReport | undefined;

  /**
   * @param opts 内层控制器 / 准入器 / 覆盖率计量器 / 覆盖率下限 / 晋升回调
   */
  public constructor(opts: {
    readonly inner: EvolutionController;
    readonly admission: PromotionAdmission;
    readonly meter: RewardCoverageMeter;
    readonly minCoverage: number;
    readonly onPromote?: ((candidate: Candidate) => void) | undefined;
  }) {
    this.inner = opts.inner;
    this.admission = opts.admission;
    this.meter = opts.meter;
    this.minCoverage = opts.minCoverage;
    this.onPromote = opts.onPromote;
    this.autoRun = opts.inner.autoRun;
  }

  /**
   * 评估单个候选（转发内层门禁，不涉及准入——准入只在 `cycle()` 的批量晋升路径上）。
   * @param candidate 待评估候选
   * @returns 门禁裁决
   */
  public evaluate(candidate: Candidate): Promise<PromotionVerdict> {
    return this.inner.evaluate(candidate);
  }

  /** 当前预算消耗（转发内层发现引擎）。
   * @returns 已生成候选数与上限
   */
  public budgetUsed(): { readonly generated: number; readonly maxCandidates: number } {
    return this.inner.budgetUsed();
  }

  /** 最近一轮体检报告（未跑过为 undefined）。
   * @returns 体检报告或 undefined
   */
  public report(): RlvrCycleReport | undefined {
    return this.lastReport;
  }

  /**
   * 跑一轮闭环：内层裁决 → 多样性闸 → 退火接受 → 覆盖率闸 → 晋升回调 + 体检报告。
   * @returns 重写后的裁决流（被任一闸否决者 promoted=false 且理由注明闸位）
   */
  public async cycle(): Promise<readonly PromotionVerdict[]> {
    const verdicts = await this.inner.cycle();
    const coverage = this.meter.report();
    const admitted = this.admission.admit(verdicts);
    const blocked = coverage.coverage < this.minCoverage;
    const final = blocked ? this.blockByCoverage(admitted.verdicts, coverage) : admitted.verdicts;
    for (const verdict of final) {
      if (verdict.promoted) this.onPromote?.(verdict.candidate);
    }
    this.lastReport = this.summarize(verdicts, final, admitted, coverage);
    this.emit(this.lastReport);
    return final;
  }

  /**
   * 覆盖率 fail-closed：覆盖率低于下限即整轮不晋升（诚实降级口径写进否决理由）。
   * @param verdicts 准入后的裁决流
   * @param coverage 覆盖率报告
   * @returns 重写后的裁决流（原本晋升者全部改为未晋升）
   */
  private blockByCoverage(
    verdicts: readonly PromotionVerdict[],
    coverage: RewardCoverageReport,
  ): readonly PromotionVerdict[] {
    return verdicts.map((v) =>
      v.promoted
        ? {
            ...v,
            promoted: false,
            reason: `${v.reason}；覆盖率闸否决晋升：${coverage.honestNote}`,
          }
        : v,
    );
  }

  /**
   * 汇总本轮体检报告。
   * @param all 内层原始裁决流
   * @param final 各级闸之后的裁决流
   * @param admitted 准入结果
   * @param coverage 覆盖率报告
   * @returns 体检报告
   */
  private summarize(
    all: readonly PromotionVerdict[],
    final: readonly PromotionVerdict[],
    admitted: AdmissionResult,
    coverage: RewardCoverageReport,
  ): RlvrCycleReport {
    const promoted = final.filter((v) => v.promoted).length;
    return {
      candidates: all.length,
      promoted,
      rejected: all.length - promoted,
      coverage: coverage.coverage,
      honestNote: coverage.honestNote,
      distinctRatio: admitted.distinctRatio,
      collapsed: admitted.collapsed,
      temperature: this.admission.temperature,
      failures: this.admission.failureCount,
      proposals: admitted.proposals.map((p) => p.summary),
    };
  }

  /**
   * 输出本轮体检（观测是尽力而为：任何异常都不连累主任务）。
   * @param report 体检报告
   * @returns 无返回值（void）
   */
  private emit(report: RlvrCycleReport): void {
    try {
      log.info('evolution.rlvr.cycle', { ...report });
      if (report.coverage < this.minCoverage) {
        log.warn('evolution.rlvr.coverage.low', {
          coverage: report.coverage,
          honestNote: report.honestNote,
        });
      }
      if (report.collapsed) {
        log.warn('evolution.rlvr.diversity.collapse', {
          distinctRatio: report.distinctRatio,
        });
      }
    } catch {
      // 观测失败不影响进化结果（fail-closed 旁路）
    }
  }
}

/**
 * 构造带「可验证门禁 + RLVR sample-filter-replay + 准入/覆盖率闸」的进化控制器
 * （U4 真接进进化闭环；T5 起晋升路径经过退火接受与多样性闸）。
 * @param opts 组合选项
 * @returns 控制器 / 回放缓冲 / 体检报告读取口
 */
export function createRlvrEvolutionController(opts: RlvrEvolutionOptions): RlvrEvolutionBundle {
  const buffer: ReplayBuffer = new InMemoryReplayBuffer();
  const sampler = modelRlvrSampler(opts.model, opts.samplesPerPrompt ?? 8);
  const meter = new RewardCoverageMeter();
  const reward =
    opts.verifyCommand !== undefined
      ? meter.wrap({
          verify: verifiableVerdictForCode(() => opts.verifyCommand, {
            codeFileExtension: opts.verifyCodeFileExtension,
          }),
        })
      : () => Promise.resolve(0);
  const loop = new RlvrLoop({
    sampler,
    reward,
    buffer,
    samplesPerPrompt: opts.samplesPerPrompt ?? 8,
    minReward: opts.minReward,
  });
  const discovery = new TwistDiscoveryEngine({
    skills: opts.skills,
    compose: opts.compose,
    maxCandidates: opts.maxCandidates ?? 12,
    fieldSize: opts.fieldSize,
  });
  const gate = new FailClosedEvolutionGate({
    // 默认门禁基准：候选技能是否携带复合（莫尔）结构（moireEnergy）；缺省安全旁路由调用方注入更针对性基准。
    benchmark:
      opts.gateBenchmark ?? ((c: Candidate) => moireEnergy(c.skill, DEFAULT_MOIRE_FIELD_SIZE)),
    minGain: opts.minGain,
  });
  const admission = opts.admission ?? new PromotionAdmission();
  const minCoverage = opts.minCoverage ?? COVERAGE_THRESHOLD;
  // 内层不持晋升回调：只有过了准入与覆盖率闸的候选才由外层触发 onPromote（否则闸只是事后观测）。
  const inner = new EvolutionControllerImpl({
    discovery,
    gate,
    autoRun: opts.autoRun ?? false,
    rlvr: { loop, promptFor: RlvrController.promptForCandidate },
  });
  const controller = new RlvrEvolutionController({
    inner,
    admission,
    meter,
    minCoverage,
    onPromote: opts.onPromote,
  });
  log.info('evolution.rlvr.controller.ready', {
    autoRun: controller.autoRun,
    minCoverage,
    verifyCommand: opts.verifyCommand !== undefined,
    samplesPerPrompt: opts.samplesPerPrompt ?? 8,
  });
  return { controller, buffer, report: () => controller.report() };
}
