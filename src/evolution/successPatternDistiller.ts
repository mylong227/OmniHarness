/**
 * 成功侧蒸馏器（商业化路线图 **E1+** 双源信号的另一半，2026-10-04）。
 *
 * ## 为什么需要它（原来的成功侧只走到固化器）
 *
 * `SignalIngestor` 原先把 success 信号喂给**相变固化器**（`crystallizer.observe`）——那是"经验密度抬升⇒冻结
 * 成**技能**"的方向。但 E1+ 要的是**另一类资产**：成功轨迹 ⇒ **工作流模板候选**
 * （`kind: 'workflow-template'`，把"这串技能连着用有效"固化成可复用流程）。
 * 两者目的不同：固化器求**单点能力**，模板蒸馏求**流程复用**。缺了后者，"成功半边"就没有进候选池的路径
 * （本探针/探针实测：`workflow-template` 只有 schema 注册、零候选生产者）。
 *
 * ## 三条纪律（都有判据）
 *
 * 1. **只吃 production 信号**：`provenance !== 'production'` 一律不入（沿信号契约的诚实边界——
 *    进化不得从 seed-bootstrap / synthetic-lab 数据里自我感动）；此项在蒸馏器侧**再挡一道**，不假设上游永远干净。
 * 2. **M3 信任档：不蒸馏工具输出正文**。候选资产只由**组合键（技能名）**构造，
 *    `evidence` 原文只作为**审计文本**留存、**绝不解析进** `description`/`instructions`。
 *    判据：evidence 里塞工具输出正文时，候选资产内**不得**出现该正文。
 * 3. **有界**：观测记录与候选数都有硬上限（§12.1-3），跨轮累积不无界增长。
 *
 * ## 与失败侧对称
 *
 * 失败侧：`FailurePatternMiner`（同签名高频 ⇒ 防再犯提案）。两侧的**输入契约相同**（都是 `EvolutionSignal`），
 * 输出不同资产类型——这正是"双源"的含义，也是判据能"掐断任一半边 ⇒ 对应候选恒 0"的前提。
 *
 * @maturity L1 — 双源对称（掐断任一半边 ⇒ 对应候选恒 0）/ production 门禁 / 不蒸馏工具输出 / 有界 判据钉死
 * @maturityEvidence tests/unit/successPatternDistiller.test.ts
 */
import type { EvolutionSignal } from '../ports/runtime/evolution.js';
import type {
  WorkflowStep,
  WorkflowTemplate,
} from '../capability/schemas/workflowTemplateSchema.js';

/** 蒸馏出的工作流模板候选（进 L1 注册表前的形状）。 */
export interface WorkflowTemplateCandidate {
  /** 候选资产本体（`WorkflowTemplateSchema.validate` 必须通过）。 */
  readonly asset: WorkflowTemplate;
  /** 聚类签名（组合键去重升序 `'|'` 连接；与信号 `key` 同构）。 */
  readonly signature: string;
  /** 观测到该组合的成功次数（≥ 阈值才成候选）。 */
  readonly frequency: number;
  /**
   * 信任档：蒸馏产物**不是** `core`——它由生产观测归纳而来，属"需要治理面"的一档。
   * 与 ADR-0009 的档位语义对齐：`signed` = 经校验/有出处的产物（模板走 Schema 校验 + 台账）。
   */
  readonly trustTier: 'signed';
  /** 审计证据（人类可读单行；**只存不解析**，见模块注释的 M3 纪律）。 */
  readonly evidence: readonly string[];
}

/** 蒸馏器选项。 */
export interface SuccessPatternDistillerOptions {
  /** 升格阈值：同一组合至少被观测到这么多次才成候选（默认 3，与失败侧对称）。 */
  readonly frequencyThreshold?: number | undefined;
  /** 观测记录累积上限（默认 512；超出淘汰最旧者）。 */
  readonly maxRecords?: number | undefined;
  /** 候选数上限（默认 64；频次降序取前 N）。 */
  readonly maxCandidates?: number | undefined;
}

/** 一次成功观测（有界缓冲里的记录）。 */
interface SuccessObservation {
  /** 组合键（去重升序 `'|'` 连接）。 */
  readonly signature: string;
  /** 组合成员（保留原始顺序，用于构造流程步骤）。 */
  readonly combination: readonly string[];
  /** 审计证据。 */
  readonly evidence: string;
}

/** 成功侧蒸馏器：成功轨迹 ⇒ 工作流模板候选（双源信号的"成功半边"）。 */
export class SuccessPatternDistiller {
  /** 升格阈值。 */
  private readonly frequencyThreshold: number;
  /** 观测记录累积上限。 */
  private readonly maxRecords: number;
  /** 候选数上限。 */
  private readonly maxCandidates: number;
  /** 跨轮累积的成功观测（有界）。 */
  private readonly observations: SuccessObservation[] = [];

  /**
   * @param opts 阈值 / 记录上限 / 候选上限（缺省各取保守默认）
   */
  public constructor(opts: SuccessPatternDistillerOptions = {}) {
    this.frequencyThreshold = Math.max(1, Math.floor(opts.frequencyThreshold ?? 3));
    this.maxRecords = Math.max(1, Math.floor(opts.maxRecords ?? 512));
    this.maxCandidates = Math.max(1, Math.floor(opts.maxCandidates ?? 64));
  }

  /**
   * 观测一条信号；非成功 / 非 production / 组合不足两个成员一律忽略。
   * @param signal 进化信号
   * @returns 是否被接受为观测
   */
  public observe(signal: EvolutionSignal): boolean {
    if (signal.kind !== 'success') return false;
    if (signal.provenance !== 'production') return false;
    const combination = signal.success?.combination;
    if (combination === undefined || combination.length < 2) return false;
    const members = [...new Set(combination.filter((m) => m.trim() !== ''))];
    if (members.length < 2) return false;
    this.observations.push({
      signature: SuccessPatternDistiller.signatureOf(members),
      combination: members,
      evidence: signal.evidence,
    });
    if (this.observations.length > this.maxRecords) {
      this.observations.splice(0, this.observations.length - this.maxRecords);
    }
    return true;
  }

  /**
   * 归纳候选：同签名频次 ≥ 阈值者升格为工作流模板（**频次降序、同频次按签名升序**，确定性）。
   * @returns 候选列表（受 `maxCandidates` 约束）
   */
  public proposals(): readonly WorkflowTemplateCandidate[] {
    const groups = new Map<
      string,
      { combination: readonly string[]; evidence: string[]; count: number }
    >();
    for (const observation of this.observations) {
      const hit = groups.get(observation.signature);
      if (hit === undefined) {
        groups.set(observation.signature, {
          combination: observation.combination,
          evidence: [observation.evidence],
          count: 1,
        });
        continue;
      }
      hit.count += 1;
      // 证据有界：每个签名最多留 3 条（审计够用，不让候选对象无界膨胀）。
      if (hit.evidence.length < 3) hit.evidence.push(observation.evidence);
    }
    return [...groups.entries()]
      .filter(([, group]) => group.count >= this.frequencyThreshold)
      .map(([signature, group]) => ({
        asset: SuccessPatternDistiller.templateOf(signature, group.combination, group.count),
        signature,
        frequency: group.count,
        trustTier: 'signed' as const,
        evidence: group.evidence,
      }))
      .sort((a, b) => b.frequency - a.frequency || (a.signature < b.signature ? -1 : 1))
      .slice(0, this.maxCandidates);
  }

  /**
   * 组合签名（去重升序 `'|'` 连接）——与 `EvolutionSignal.key` 同构，便于与信号侧对齐。
   * @param members 组合成员
   * @returns 签名
   */
  private static signatureOf(members: readonly string[]): string {
    return [...members].sort().join('|');
  }

  /**
   * 由组合键构造工作流模板。
   *
   * **为什么只吃组合键**：M3 信任档要求不把工具输出正文蒸馏成资产内容。模板的步骤 = 组合成员按序串联
   * （`requires` 用前一步的 `produces`，首步无依赖），`inputs` = 首成员——全部来自**技能名**，
   * 与 evidence 正文无关。名称带签名哈希后缀，保证同名组合得到同一模板名（确定性、可去重）。
   * @param signature 组合签名
   * @param combination 组合成员（原始顺序）
   * @param frequency 观测频次
   * @returns 工作流模板（应能通过 `WorkflowTemplateSchema.validate`）
   */
  private static templateOf(
    signature: string,
    combination: readonly string[],
    frequency: number,
  ): WorkflowTemplate {
    const steps: WorkflowStep[] = combination.map((member, index) => ({
      name: `step-${String(index + 1)}`,
      action: member,
      requires: index === 0 ? [] : [combination[index - 1] ?? member],
      produces: [member],
    }));
    return {
      name: `wf-${SuccessPatternDistiller.shortHash(signature)}`,
      description: `由 ${String(frequency)} 次生产成功组合蒸馏的工作流模板（${signature}）`,
      inputs: [combination[0] ?? 'input'],
      steps,
    };
  }

  /**
   * 签名的短哈希（确定性、无依赖）：FNV-1a 32 位 → 8 位十六进制。
   * @param text 输入文本
   * @returns 8 位十六进制串
   */
  private static shortHash(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }
}
