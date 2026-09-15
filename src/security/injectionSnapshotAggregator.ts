/**
 * 注入快照度量聚合器（零依赖，实验性 @beta）。
 *
 * P4 拆分：把「逐例归类 + 交叉汇总」从 `evaluateSnapshot` 抽出为有状态聚合器，
 * 使编排函数保持在「函数体 ≤ 80 行」铁律内。本类同时是**度量域**的类型宿主
 * （用例 / 逐例结果 / 类别与来源汇总 / 报告形状）。
 *
 * 度量口径（与 `injectionMetric` 文档一致）：
 * - TP = 恶意且被拦截；FN = 恶意且放行；FP = 良性且被拦截；TN = 良性且放行。
 * - recall = TP/(TP+FN)；falsePositiveRate = FP/(FP+TN)；precision = TP/(TP+FP)。
 */
import { ToolOutputTrust, type TrustTier } from './toolOutputTrust.js';

/** 单条注入用例（来自离线快照）。 */
export interface InjectionCase {
  /** 用例 id（快照内唯一）。 */
  readonly id: string;
  /** 标注：恶意 / 良性。 */
  readonly label: 'malicious' | 'benign';
  /** 类别（DIRECTIVES taxonomy 或 tool-output / natural-language 等）。 */
  readonly category: string;
  /** 待扫描文本。 */
  readonly text: string;
  /** 内容来源信任级（可选；缺省按 `unknown` 判定，即 P4 之前的统一敏感度）。 */
  readonly source?: TrustTier;
}

/** 单条用例的判定结果。 */
export interface CaseOutcome {
  /** 用例 id。 */
  readonly id: string;
  /** 标注。 */
  readonly label: 'malicious' | 'benign';
  /** 类别。 */
  readonly category: string;
  /** 判定所用的来源信任级。 */
  readonly tier: TrustTier;
  /** 护栏是否拦截。 */
  readonly blocked: boolean;
  /** 命中规则数。 */
  readonly hits: number;
}

/** 单类别汇总。 */
export interface CategoryStat {
  /** 该类别用例总数。 */
  readonly total: number;
  /** 该类别被检出的（恶意且拦截）数。 */
  readonly detected: number;
  /** 该类别误报（良性且拦截）数。 */
  readonly fp: number;
  /** 该类别检测率（恶意子集中）。 */
  readonly recall: number;
  /** 该类别误报率（良性子集中）。 */
  readonly fpRate: number;
}

/** 单来源汇总（P4：来源维度）。 */
export interface SourceStat {
  /** 该来源的中文标签。 */
  readonly label: string;
  /** 该来源用例总数。 */
  readonly total: number;
  /** 该来源恶意数。 */
  readonly malicious: number;
  /** 该来源被检出的恶意数。 */
  readonly detected: number;
  /** 该来源良性数。 */
  readonly benign: number;
  /** 该来源误报数。 */
  readonly fp: number;
  /** 该来源检测率（恶意子集中）。 */
  readonly recall: number;
  /** 该来源误报率（良性子集中）。 */
  readonly fpRate: number;
}

/** 全快照度量报告。 */
export interface SnapshotReport {
  /** 用例总数。 */
  readonly total: number;
  /** 恶意数。 */
  readonly malicious: number;
  /** 良性数。 */
  readonly benign: number;
  /** 真阳性。 */
  readonly tp: number;
  /** 假阴性。 */
  readonly fn: number;
  /** 假阳性。 */
  readonly fp: number;
  /** 真阴性。 */
  readonly tn: number;
  /** 检测率（恶性召回）。 */
  readonly recall: number;
  /** 误报率。 */
  readonly falsePositiveRate: number;
  /** 精度。 */
  readonly precision: number;
  /** 总准确率。 */
  readonly accuracy: number;
  /** 按类别拆分。 */
  readonly byCategory: Readonly<Record<string, CategoryStat>>;
  /** 按来源信任级拆分（P4）。 */
  readonly bySource: Readonly<Record<string, SourceStat>>;
  /** 逐用例结果。 */
  readonly cases: readonly CaseOutcome[];
  /** 所用护栏标识。 */
  readonly guard: string;
}

/** 单来源聚合累加器。 */
interface SourceAccumulator {
  malicious: number;
  detected: number;
  benign: number;
  fp: number;
}

/** 单类别聚合累加器。 */
interface CategoryAccumulator {
  total: number;
  detected: number;
  fp: number;
}

/** 除法守卫（分母为 0 时返回 0）。 */
const ratio = (num: number, den: number): number => (den === 0 ? 0 : num / den);

/**
 * 逐例累加 + 产出度量的有状态聚合器（一次评估用一个实例）。
 */
export class InjectionSnapshotAggregator {
  /** 真阳性计数。 */
  private tp = 0;
  /** 假阴性计数。 */
  private fn = 0;
  /** 假阳性计数。 */
  private fp = 0;
  /** 真阴性计数。 */
  private tn = 0;
  /** 恶意子集按类别累加。 */
  private readonly malByCat = new Map<string, CategoryAccumulator>();
  /** 良性子集按类别累加。 */
  private readonly benByCat = new Map<string, CategoryAccumulator>();
  /** 按来源信任级累加。 */
  private readonly bySourceAcc = new Map<TrustTier, SourceAccumulator>();

  /**
   * 记录一条用例的判定结果（累加计数与分组）。
   *
   * @param c 用例（读取 id / label / category）。
   * @param tier 判定所用来源信任级。
   * @param blocked 护栏是否拦截。
   * @param hits 命中规则数（扫描器异常时调用方传 0）。
   * @returns 该用例的逐例结果（调用方按原序收集为报告的 cases）。
   */
  public record(c: InjectionCase, tier: TrustTier, blocked: boolean, hits: number): CaseOutcome {
    const srcAgg = this.bySourceAcc.get(tier) ?? { malicious: 0, detected: 0, benign: 0, fp: 0 };
    if (c.label === 'malicious') {
      if (blocked) {
        this.tp += 1;
        srcAgg.detected += 1;
      } else {
        this.fn += 1;
      }
      srcAgg.malicious += 1;
      const agg = this.malByCat.get(c.category) ?? { total: 0, detected: 0, fp: 0 };
      agg.total += 1;
      if (blocked) {
        agg.detected += 1;
      }
      this.malByCat.set(c.category, agg);
    } else {
      if (blocked) {
        this.fp += 1;
        srcAgg.fp += 1;
      } else {
        this.tn += 1;
      }
      srcAgg.benign += 1;
      const agg = this.benByCat.get(c.category) ?? { total: 0, detected: 0, fp: 0 };
      agg.total += 1;
      if (blocked) {
        agg.fp += 1;
      }
      this.benByCat.set(c.category, agg);
    }
    this.bySourceAcc.set(tier, srcAgg);
    return { id: c.id, label: c.label, category: c.category, tier, blocked, hits };
  }

  /**
   * 由已记录的逐例结果产出完整度量报告。
   *
   * @param total 用例总数。
   * @param cases 逐例结果（按原序）。
   * @returns 度量报告（含 byCategory / bySource 拆分与总体指标）。
   */
  public build(total: number, cases: readonly CaseOutcome[]): SnapshotReport {
    const byCategory: Record<string, CategoryStat> = {};
    const cats = new Set<string>([...this.malByCat.keys(), ...this.benByCat.keys()]);
    for (const cat of cats) {
      const m = this.malByCat.get(cat);
      const b = this.benByCat.get(cat);
      byCategory[cat] = {
        total: (m?.total ?? 0) + (b?.total ?? 0),
        detected: m?.detected ?? 0,
        fp: b?.fp ?? 0,
        recall: ratio(m?.detected ?? 0, m?.total ?? 0),
        fpRate: ratio(b?.fp ?? 0, b?.total ?? 0),
      };
    }

    const bySource: Record<string, SourceStat> = {};
    for (const [tier, agg] of this.bySourceAcc) {
      bySource[tier] = {
        label: ToolOutputTrust.labelOf(tier),
        total: agg.malicious + agg.benign,
        malicious: agg.malicious,
        detected: agg.detected,
        benign: agg.benign,
        fp: agg.fp,
        recall: ratio(agg.detected, agg.malicious),
        fpRate: ratio(agg.fp, agg.benign),
      };
    }

    const malicious = this.tp + this.fn;
    const benign = this.fp + this.tn;
    return {
      total,
      malicious,
      benign,
      tp: this.tp,
      fn: this.fn,
      fp: this.fp,
      tn: this.tn,
      recall: ratio(this.tp, malicious),
      falsePositiveRate: ratio(this.fp, benign),
      precision: ratio(this.tp, this.tp + this.fp),
      accuracy: ratio(this.tp + this.tn, total),
      byCategory,
      bySource,
      cases,
      guard: 'scanForInjection',
    };
  }
}
