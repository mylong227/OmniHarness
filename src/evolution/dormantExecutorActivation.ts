/**
 * 休眠执行体转正（GEE Kernel v1 · ⑥ 执行体环，ADR-0008 决策 6 / EVOLVIX_SPEC §2）。
 *
 * 解决的问题（ADR-0008 §背景 3）：`CRISPRSkillEditor` 与 `CapabilityCrystallizer` 机制完整、
 * 但**零生产调用方**（只有 spark 域与测试在调）——「精密仪器空转」。本类把它们接进 Kernel
 * 周期，且**只走各自的既有铁律**，不发明第二条路径：
 *
 * 1. **CRISPR 定点改进**（针对既有技能）：把 ring ① 的失败改进提案翻成 `CrisprEditSpec`
 *    （语义寻址定位既有技能 → 追加防再犯条款 → **差异测试 = 门禁基准非回退**）→ `queue()`
 *    → `flush()`。差异测试不通过即回滚、原技能一字不动（编辑器自带的 fail-closed）。
 * 2. **相变固化**（针对高频成功组合）：`observe()` 已在 ring ① 由信号路由器调用，本类只负责
 *    **越阈冻结**（`crystallize()`）——加法式：只新增原生能力，绝不删改源组合或既有能力。
 *
 * 幂等与有界（判据钉死）：
 * - 防再犯条款带标记，重复提案只报 `no-op`（同一失败模式反复出现不会把 instructions 撑爆）；
 * - 单轮排队提案数有上限（编辑成本是评估预算的一部分，提案数无上限而编辑预算有上限）。
 *
 * @maturity L1 — 两条转正路径的端到端判据钉死（差异测试拦截/回滚、固化加法式与密度归零）
 * @maturityEvidence tests/unit/dormantExecutorActivation.test.ts
 */
import type { CapabilityCrystallizerPort } from '../ports/intelligence/capability.js';
import type { CRISPRSkillEditorPort, CrisprEditSpec } from '../ports/runtime/skillEdit.js';
import type { Skill } from '../skill/skill.js';
import type { ImprovementProposal } from './failurePatternMiner.js';

/** 防再犯条款标记（幂等锚点：已带此标记的 instructions 不再重复追加）。 */
const GUARD_MARKER = '【防再犯】';

/** 休眠执行体转正选项。 */
export interface DormantExecutorActivationOptions {
  /**
   * 门禁基准打分（差异测试的尺子）：修订后的技能得分**不得低于**修订前。
   * 组合根应传入与 ring ④ 门禁**同一把尺**（`RlvrController.defaultGateScore`），
   * 否则「非回退」在两个空间里各说各话。
   */
  readonly score: (skill: Skill) => number;
  /** CRISPR 编辑器端口（缺省 = 不产出改进提案，如实申报缺件）。 */
  readonly crispr?: CRISPRSkillEditorPort | undefined;
  /** 相变固化器端口（缺省 = 不结晶，如实申报缺件）。 */
  readonly crystallizer?: CapabilityCrystallizerPort | undefined;
  /** 单轮最多排队的改进提案数（默认 4；超出的提案留待下轮，不无界膨胀）。 */
  readonly maxProposals?: number | undefined;
  /** 语义寻址共振阈值（透传 `CrisprEditSpec`；缺省用编辑器自身默认）。 */
  readonly addressThreshold?: number | undefined;
}

/** 执行体转正明细（Kernel 体检报告的数据源）。 */
export interface ExecutorActivationReport {
  /** 本轮排队的改进提案数。 */
  readonly crisprQueued: number;
  /** 差异测试通过并提交的编辑数。 */
  readonly crisprApplied: number;
  /** 差异测试不通过被回滚的编辑数（脱靶被防住）。 */
  readonly crisprRolledBack: number;
  /** 未命中既有技能 / 无操作（幂等）而跳过的编辑数。 */
  readonly crisprSkipped: number;
  /** 本轮新冻结的原生能力数。 */
  readonly crystallized: number;
  /** 越阈但早前已冻结（不重复注册）的组合数。 */
  readonly alreadyFrozen: number;
  /** 越阈但被跳过（成员缺失 / 命名冲突 / 涌现不足）的组合数。 */
  readonly crystallizationSkipped: number;
}

/** 休眠执行体转正：把失败提案送进 CRISPR，把越阈成功组合冻结为原生能力。 */
export class DormantExecutorActivation {
  /** 门禁基准打分（差异测试用）。 */
  private readonly score: (skill: Skill) => number;
  /** CRISPR 编辑器端口。 */
  private readonly crispr?: CRISPRSkillEditorPort | undefined;
  /** 相变固化器端口。 */
  private readonly crystallizer?: CapabilityCrystallizerPort | undefined;
  /** 单轮排队上限。 */
  private readonly maxProposals: number;
  /** 语义寻址阈值。 */
  private readonly addressThreshold?: number | undefined;

  /**
   * @param opts 打分尺子 / CRISPR / 固化器 / 排队上限 / 寻址阈值（缺件各按缺省，如实申报）
   */
  public constructor(opts: DormantExecutorActivationOptions) {
    this.score = opts.score;
    this.crispr = opts.crispr;
    this.crystallizer = opts.crystallizer;
    this.maxProposals = Math.max(1, Math.floor(opts.maxProposals ?? 4));
    this.addressThreshold = opts.addressThreshold;
  }

  /**
   * 装配缺件申报（子件缺失如实申报；由 Kernel 汇入 `degraded` 口径）。
   * @returns 缺件标识列表（满配为空数组）
   */
  public degraded(): readonly string[] {
    const missing: string[] = [];
    if (this.crispr === undefined) missing.push('crispr:missing');
    if (this.crystallizer === undefined) missing.push('crystallizer:missing');
    return missing;
  }

  /**
   * 跑一轮执行体转正：先 CRISPR 定点改进（针对既有技能），后相变固化（冻结高频组合）。
   *
   * 顺序理由：固化是**加法**（新增原生能力，成为后续组合的可用成员），改进是**原地修订**；
   * 先改进再固化，可让本轮刚修订过的技能参与固化组合，且固化产物不再被本轮修订波及。
   * @param proposals ring ① 产出的失败改进提案
   * @returns 明细（应用数 / 回滚数 / 冻结数 / 跳过数与原因计数）
   */
  public activate(proposals: readonly ImprovementProposal[]): ExecutorActivationReport {
    const crispr = this.revise(proposals);
    const crystallization = this.freezeThresholdCombos();
    return { ...crispr, ...crystallization };
  }

  /**
   * CRISPR 定点改进：提案 → `CrisprEditSpec`（差异测试 = 门禁基准非回退）→ queue → flush。
   * @param proposals 失败改进提案（频次降序）
   * @returns CRISPR 侧计数
   */
  private revise(proposals: readonly ImprovementProposal[]): {
    readonly crisprQueued: number;
    readonly crisprApplied: number;
    readonly crisprRolledBack: number;
    readonly crisprSkipped: number;
  } {
    const empty = { crisprQueued: 0, crisprApplied: 0, crisprRolledBack: 0, crisprSkipped: 0 };
    if (this.crispr === undefined) return empty;
    const batch = proposals.slice(0, this.maxProposals);
    for (const proposal of batch) {
      this.crispr.queue(this.specOf(proposal));
    }
    const reports = this.crispr.flush();
    let applied = 0;
    let rolledBack = 0;
    for (const report of reports) {
      if (report.applied) applied++;
      else if (report.rolledBack) rolledBack++;
    }
    return {
      crisprQueued: batch.length,
      crisprApplied: applied,
      crisprRolledBack: rolledBack,
      crisprSkipped: reports.length - applied - rolledBack,
    };
  }

  /**
   * 把一条改进提案翻成 CRISPR 编辑规格。
   *
   * - **目标** = 提案摘要（`CrisprEditSpec.target` 非精确名时走语义寻址，按共振取最相关技能）；
   * - **patch** = 追加带标记的防再犯条款（已带标记则原样返回 → 编辑器报 `no-op`，幂等）；
   * - **差异测试** = 门禁基准非回退（`score(patched) >= score(original)`）——**必须提供**：
   *   编辑器的缺省语义是「不传即接受」，那是生产不可接受的缺省。
   * @param proposal 改进提案
   * @returns 编辑规格
   */
  private specOf(proposal: ImprovementProposal): CrisprEditSpec {
    const clause = DormantExecutorActivation.guardClause(proposal);
    const score = this.score;
    return {
      target: proposal.summary,
      patch: (instructions: string): string =>
        instructions.includes(GUARD_MARKER) ? instructions : `${instructions}\n${clause}`,
      differentialTest: (original: Skill, patched: Skill): boolean =>
        score(patched) >= score(original),
      ...(this.addressThreshold !== undefined ? { addressThreshold: this.addressThreshold } : {}),
    };
  }

  /**
   * 防再犯条款（纯函数，幂等锚点自带）。
   * @param proposal 改进提案
   * @returns 追加到 instructions 的单行条款
   */
  public static guardClause(proposal: ImprovementProposal): string {
    return `${GUARD_MARKER}同类失败「${proposal.signatureKey}」已出现 ${proposal.occurrences} 次：执行本步骤前先核对前置条件与输入形状。`;
  }

  /**
   * 越阈结晶：把密度越界的成功组合冻结为原生能力（加法式，编辑器/固化器铁律不越权）。
   * @returns 固化侧计数
   */
  private freezeThresholdCombos(): {
    readonly crystallized: number;
    readonly alreadyFrozen: number;
    readonly crystallizationSkipped: number;
  } {
    if (this.crystallizer === undefined) {
      return { crystallized: 0, alreadyFrozen: 0, crystallizationSkipped: 0 };
    }
    const report = this.crystallizer.crystallize();
    return {
      crystallized: report.frozen.length,
      alreadyFrozen: report.alreadyFrozen,
      crystallizationSkipped: report.skipped.length,
    };
  }
}
