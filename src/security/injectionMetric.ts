/**
 * A4 离线注入度量（零依赖，实验性 @beta）。
 *
 * 对「离线 curated 注入用例快照」跑 {@link scanForInjection}，算出
 * 检测率（recall）/ 误报率（false-positive）/ 精度（precision）与按类别拆分。
 * 纯函数、无副作用；快照不联网取 AgentDojo/InjecAgent（D4 主门禁禁联网），
 * 仅作护栏质量的离线代理信号。
 *
 * 度量口径：
 * - TP = 恶意且被拦截；FN = 恶意且放行；FP = 良性且被拦截；TN = 良性且放行。
 * - recall（检测率）= TP / (TP + FN)         —— 越高越好。
 * - falsePositiveRate = FP / (FP + TN)       —— 越低越好。
 * - precision = TP / (TP + FP)               —— 越高越好。
 */
import { scanForInjection } from './promptInjectionGuard.js';

/** 单条注入用例（来自离线快照）。 */
export interface InjectionCase {
  /** 用例 id（快照内唯一）。 */
  readonly id: string;
  /** 标注：恶意 / 良性。 */
  readonly label: 'malicious' | 'benign';
  /** 类别（DIRECTIVES  taxonomy 或 tool-output / natural-language 等）。 */
  readonly category: string;
  /** 待扫描文本。 */
  readonly text: string;
}

/** 单条用例的判定结果。 */
export interface CaseOutcome {
  /** 用例 id。 */
  readonly id: string;
  /** 标注。 */
  readonly label: 'malicious' | 'benign';
  /** 类别。 */
  readonly category: string;
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
  /** 逐用例结果。 */
  readonly cases: readonly CaseOutcome[];
  /** 所用护栏标识。 */
  readonly guard: string;
}

/**
 * 对快照跑护栏并汇总度量。
 *
 * @param cases 离线 curated 用例
 * @returns 度量报告
 */
export function evaluateSnapshot(cases: readonly InjectionCase[]): SnapshotReport {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;
  const malByCat = new Map<string, { total: number; detected: number }>();
  const benByCat = new Map<string, { total: number; fp: number }>();
  const outcomes: CaseOutcome[] = [];

  for (const c of cases) {
    const scan = scanForInjection(c.text);
    const blocked = scan.blocked;
    outcomes.push({
      id: c.id,
      label: c.label,
      category: c.category,
      blocked,
      hits: scan.score < 0 ? 0 : scan.score,
    });

    if (c.label === 'malicious') {
      if (blocked) {
        tp += 1;
      } else {
        fn += 1;
      }
      const agg = malByCat.get(c.category) ?? { total: 0, detected: 0 };
      agg.total += 1;
      if (blocked) agg.detected += 1;
      malByCat.set(c.category, agg);
    } else {
      if (blocked) {
        fp += 1;
      } else {
        tn += 1;
      }
      const agg = benByCat.get(c.category) ?? { total: 0, fp: 0 };
      agg.total += 1;
      if (blocked) agg.fp += 1;
      benByCat.set(c.category, agg);
    }
  }

  const ratio = (num: number, den: number): number => (den === 0 ? 0 : num / den);
  const byCategory: Record<string, CategoryStat> = {};
  const cats = new Set<string>([...malByCat.keys(), ...benByCat.keys()]);
  for (const cat of cats) {
    const m = malByCat.get(cat);
    const b = benByCat.get(cat);
    byCategory[cat] = {
      total: (m?.total ?? 0) + (b?.total ?? 0),
      detected: m?.detected ?? 0,
      fp: b?.fp ?? 0,
      recall: ratio(m?.detected ?? 0, m?.total ?? 0),
      fpRate: ratio(b?.fp ?? 0, b?.total ?? 0),
    };
  }

  const total = cases.length;
  const malicious = tp + fn;
  const benign = fp + tn;
  return {
    total,
    malicious,
    benign,
    tp,
    fn,
    fp,
    tn,
    recall: ratio(tp, malicious),
    falsePositiveRate: ratio(fp, benign),
    precision: ratio(tp, tp + fp),
    accuracy: ratio(tp + tn, total),
    byCategory,
    cases: outcomes,
    guard: 'scanForInjection',
  };
}
