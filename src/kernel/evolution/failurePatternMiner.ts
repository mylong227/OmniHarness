/**
 * 失败模式挖掘器（T4.3 · H3 · Harness Engineering）。
 *
 * 解决的问题：门禁/测试的失败记录散落各处、反复出现却无人归纳——同类失败以相同根因
 * 一犯再犯。挖掘器把失败记录**按签名聚类**（失败种类 × 模块域），频率超阈值的签名升格为
 * 「改进提案」；提案经采纳登记（带证据提交哈希）后进入已采纳台账，供回归对照。
 *
 * 与 TwistDiscoveryEngine 的分工：Twist 在**技能空间**做有界探索生成候选能力；
 * 本器在**失败空间**做归纳，产出「防再犯」类改进提案（门禁项/检测器/清单判据）。
 *
 * 确定性：聚类与提案排序均为纯规则（频次降序 → 首次出现序），同输入恒同提案集。
 *
 * @maturity L1 — 挖掘与采纳台账是真实机制；「≥1 条改进被采纳」由测试登记真实提交证据
 * @maturityEvidence tests/unit/failurePatternMiner.test.ts
 */

/** 一条失败记录（来自门禁/测试/eval 的原始失败）。 */
export interface FailureRecord {
  /** 失败种类（如 'gate:delta' / 'test:assert' / 'eval:passk'）。 */
  readonly kind: string;
  /** 发生位置（文件路径或用例名）。 */
  readonly location: string;
  /** 单行失败描述。 */
  readonly message: string;
}

/** 挖掘出的失败签名（聚类）。 */
export interface FailureSignature {
  /** 签名键：`kind × 域`（域取 location 的首个路径段或用例前缀）。 */
  readonly key: string;
  /** 出现次数。 */
  readonly count: number;
  /** 首条与末条的位置样本。 */
  readonly samples: readonly string[];
}

/** 改进提案（频率超阈值的签名升格）。 */
export interface ImprovementProposal {
  /** 签名键。 */
  readonly signatureKey: string;
  /** 出现次数。 */
  readonly occurrences: number;
  /** 提案摘要（防再犯方向）。 */
  readonly summary: string;
  /** 采纳状态与证据（采纳时填）。 */
  readonly adopted?: { readonly evidence: string };
}

/** 已采纳台账条目。 */
export interface AdoptedImprovement {
  /** 签名键。 */
  readonly signatureKey: string;
  /** 提案摘要。 */
  readonly summary: string;
  /** 采纳证据（提交哈希 / 门禁项名 / 检测器类名——可追溯）。 */
  readonly evidence: string;
}

/**
 * 失败模式挖掘器：签名聚类 → 提案 → 采纳台账。
 */
export class FailurePatternMiner {
  /** 提案升格的频率阈值（默认 3：同签名 ≥3 次即值得防再犯）。 */
  private readonly frequencyThreshold: number;
  /** 已采纳台账（按采纳顺序）。 */
  private readonly ledger: AdoptedImprovement[] = [];

  /**
   * @param frequencyThreshold 提案升格阈值（默认 3）
   */
  public constructor(frequencyThreshold = 3) {
    this.frequencyThreshold = Math.max(1, Math.floor(frequencyThreshold));
  }

  /**
   * 挖掘：聚类失败记录并升格高频签名为改进提案（按频次降序 → 首现序，确定性）。
   * @param records 失败记录流
   * @returns 全部签名（含未达阈值）与升格提案
   */
  public mine(records: readonly FailureRecord[]): {
    signatures: readonly FailureSignature[];
    proposals: readonly ImprovementProposal[];
  } {
    const clusters = new Map<string, { count: number; samples: string[]; order: number }>();
    for (const r of records) {
      const key = `${r.kind} × ${this.domainOf(r.location)}`;
      const entry = clusters.get(key) ?? { count: 0, samples: [], order: clusters.size };
      entry.count += 1;
      if (entry.samples.length < 2) entry.samples.push(r.location);
      clusters.set(key, entry);
    }
    const signatures = [...clusters.entries()]
      .map(([key, v]) => ({ key, count: v.count, samples: v.samples }))
      .sort((a, b) => b.count - a.count);
    const proposals = signatures
      .filter((s) => s.count >= this.frequencyThreshold)
      .map((s): ImprovementProposal => ({
        signatureKey: s.key,
        occurrences: s.count,
        summary: `「${s.key}」失败 ${s.count} 次：建议以机械门禁/检测器/清单判据防再犯（样本：${s.samples.join('、')}）`,
      }));
    return { signatures, proposals };
  }

  /**
   * 登记采纳：提案落地后凭证据（提交哈希/门禁项名）入台账。
   * @param proposal 被采纳的提案
   * @param evidence 采纳证据（可追溯：commit 哈希或门禁项名）
   * @returns 台账条目
   */
  public adopt(proposal: ImprovementProposal, evidence: string): AdoptedImprovement {
    const entry: AdoptedImprovement = {
      signatureKey: proposal.signatureKey,
      summary: proposal.summary,
      evidence,
    };
    this.ledger.push(entry);
    return entry;
  }

  /**
   * 已采纳台账（≥1 条即满足 H3 的「改进被采纳」验收）。
   * @returns 台账只读视图
   */
  public adoptedLedger(): readonly AdoptedImprovement[] {
    return this.ledger;
  }

  /**
   * 失败位置 → 域（首个路径段；无斜杠取首段词）。
   * @param location 失败位置（文件路径或用例名）
   * @returns 域键（截断到 40 字符）
   */
  private domainOf(location: string): string {
    const normalized = location.split('\\').join('/');
    const first = normalized.split('/')[0] ?? normalized;
    return first.slice(0, 40);
  }
}
