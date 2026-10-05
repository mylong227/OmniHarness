/**
 * 注入护栏离线自检（doctor 面）——把此前两件互不相接的资产（生产护栏 `PromptInjectionGuard`
 * 与离线度量 `InjectionMetric`）变成一条用户可跑的诊断输出。
 *
 * ## 为什么放在 doctor 而不是新命令
 *
 * doctor 已是「安全边界自述」的既定出口（G5：隔离强度 / 网络守卫覆盖 / 注入护栏档位），
 * 但此前它只报**档位与阈值**（护栏开没开、多严），不报**质量**（开了到底拦不拦得住）。
 * 质量度量与 curated 快照早已存在（`InjectionMetric` + 32 例快照），缺的只是把它们
 * 接进用户面的最后一段——正是本仓最高频的「声明未接线」形态。
 *
 * ## 口径（诚实边界，逐字印进 doctor 输出）
 *
 * - 输入是 **curated 离线快照**（`defaults/injection-snapshot.json`，手工撰写，
 *   AgentDojo / InjecAgent 的离线代理；主门禁 D4 禁联网，不做真实抓取）。
 * - 因此数字回答的是「护栏对这批手工用例的手感」，**不是**真实攻击分布下的召回/误报率。
 *   真实流量上的证据由 enforcement 的 `shadow` 档在生产流量上攒（见 `enforcementModeResolver.ts`）。
 *
 * 结构校验 fail-closed：快照缺失 / JSON 非法 / 用例缺字段 / id 重复一律抛错，
 * 由 doctor 转成问题项——绝不静默输出空报告冒充「检查通过」。
 */
import { builtinDefaults } from '../util/builtinDefaults.js';
import { InjectionMetric } from './injectionMetric.js';
import type { InjectionCase, SnapshotReport } from './injectionSnapshotAggregator.js';
import type { TrustTier } from './toolOutputTrust.js';

/** 快照文件在 `defaults/` 下的数据名（`BuiltinDefaults.json` 口径，I6 门禁据此强制随包发布）。 */
const SNAPSHOT_NAME = 'injection-snapshot';

/** 来源信任级全集（`ToolOutputTrust` 的 `TrustTier`；快照校验用，避免反向依赖实现类）。 */
const TRUST_TIERS = ['external', 'file', 'local', 'memory', 'unknown'] as const;

/** doctor 可直接消费的自检摘要（全部为纯量 + 一条口径注记）。 */
export interface InjectionSelfCheckSummary {
  /** 快照用例总数。 */
  readonly cases: number;
  /** 检测率 recall = TP / (TP + FN)，越高越好。 */
  readonly recall: number;
  /** 误报率 FP / (FP + TN)，越低越好。 */
  readonly falsePositiveRate: number;
  /** 精度 TP / (TP + FP)，越高越好。 */
  readonly precision: number;
  /** 口径注记（逐字转述，防「离线代理数字被当真实攻击统计」）。 */
  readonly basis: string;
}

/**
 * 注入护栏离线自检：从内建 curated 快照构造，对生产护栏逐例扫描并产出摘要。
 */
export class InjectionSelfCheck {
  /** 快照用例（构造期已校验，逐例合法）。 */
  private readonly cases: readonly InjectionCase[];

  /**
   * @param cases 快照用例；请经 {@link InjectionSelfCheck.fromJson} 构造以获得校验。
   */
  private constructor(cases: readonly InjectionCase[]) {
    this.cases = cases;
  }

  /**
   * 从内建快照构造（`defaults/injection-snapshot.json`；fail-closed）。
   * @returns 自检实例
   * @throws Error 快照缺失 / JSON 非法 / 顶层结构不符 / 用例字段缺失或 id 重复时抛出
   */
  public static fromBuiltinSnapshot(): InjectionSelfCheck {
    return InjectionSelfCheck.fromJson(builtinDefaults.json(SNAPSHOT_NAME));
  }

  /**
   * 从已解析的快照 JSON 构造（结构校验，`unknown` 收窄，无 `any`）。
   * @param raw 快照 JSON 值（顶层 `{ cases: [...] }`）
   * @returns 自检实例
   * @throws Error 结构不符时抛出，消息点名第一个不合法的用例
   */
  public static fromJson(raw: unknown): InjectionSelfCheck {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('注入快照顶层应为对象 { cases: [...] }');
    }
    const casesValue = (raw as { cases?: unknown }).cases;
    if (!Array.isArray(casesValue) || casesValue.length === 0) {
      throw new Error('注入快照 cases 应为非空数组');
    }
    const seen = new Set<string>();
    const cases: InjectionCase[] = casesValue.map((item, index) => {
      const c = InjectionSelfCheck.caseOf(item, index);
      if (seen.has(c.id)) throw new Error(`注入快照存在重复用例 id：${c.id}`);
      seen.add(c.id);
      return c;
    });
    return new InjectionSelfCheck(cases);
  }

  /**
   * 校验并收窄单个用例。
   * @param item 原始 JSON 值
   * @param index 在 cases 数组中的下标（用于错误定位）
   * @returns 合法用例
   * @throws Error 字段缺失或类型不符时抛出
   */
  private static caseOf(item: unknown, index: number): InjectionCase {
    const at = `cases[${String(index)}]`;
    if (typeof item !== 'object' || item === null) {
      throw new Error(`注入快照用例 ${at} 应为对象`);
    }
    const record = item as Record<string, unknown>;
    const id = record['id'];
    if (typeof id !== 'string' || id === '') throw new Error(`注入快照用例 ${at} 缺 id`);
    const label = record['label'];
    if (label !== 'malicious' && label !== 'benign') {
      throw new Error(`注入快照用例 ${at}（${id}）label 非法：${String(label)}`);
    }
    const category = record['category'];
    if (typeof category !== 'string' || category === '') {
      throw new Error(`注入快照用例 ${at}（${id}）缺 category`);
    }
    const text = record['text'];
    if (typeof text !== 'string') throw new Error(`注入快照用例 ${at}（${id}）缺 text`);
    const source = record['source'];
    if (
      source !== undefined &&
      (typeof source !== 'string' || !(TRUST_TIERS as readonly string[]).includes(source))
    ) {
      throw new Error(`注入快照用例 ${at}（${id}）source 非法：${String(source)}`);
    }
    return {
      id,
      label,
      category,
      text,
      // 已经过上面 TRUST_TIERS 成员校验，此处收窄为 TrustTier（非 any）。
      ...(typeof source === 'string' ? { source: source as TrustTier } : {}),
    };
  }

  /**
   * 对生产护栏逐例扫描并汇总度量（委托 {@link InjectionMetric.evaluateSnapshot}，判据单一来源）。
   * @returns 度量报告（含逐例结果与分类拆分）
   */
  public evaluate(): SnapshotReport {
    return InjectionMetric.evaluateSnapshot(this.cases);
  }

  /**
   * 产出 doctor 摘要（纯量 + 口径注记；注记必须随数字一起展示，防止误读）。
   * @returns 自检摘要
   */
  public summary(): InjectionSelfCheckSummary {
    const r = this.evaluate();
    return {
      cases: r.total,
      recall: r.recall,
      falsePositiveRate: r.falsePositiveRate,
      precision: r.precision,
      basis: `curated 离线代理快照（AgentDojo/InjecAgent 代理，${String(r.total)} 例手工撰写），非真实攻击统计`,
    };
  }
}
