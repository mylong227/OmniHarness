import { LocalDay } from '../util/localDay.js';
import { QuotaPlans, type QuotaPlan } from './quotaPlans.js';
import type { QuotaStore } from './quotaStore.js';
import type { SessionArchive } from './sessionArchive.js';

/** 单个模型的当日配额行。 */
export interface QuotaModelRow {
  /** 模型名（用量归组键，未知模型为 `unknown`）。 */
  readonly name: string;
  /** 当日已用 token 数。 */
  readonly used: number;
  /** 当日额度（基础日预算 × 档位倍率）。 */
  readonly limit: number;
  /** 剩余百分比（0–100 取整；已超额时为 0，不出现负数以免 UI 画反）。 */
  readonly remainingPercent: number;
}

/** 配额状态报告（`quota.get` / `quota.set` 的返回体）。 */
export interface QuotaStatus {
  /** 当前档位。 */
  readonly plan: QuotaPlan;
  /** 基础日预算（档位倍率乘算前的基数）。 */
  readonly dailyTokens: number;
  /** 生效日额度（基础 × 倍率）。 */
  readonly effectiveTokens: number;
  /** 全模型合计已用 token。 */
  readonly usedTokens: number;
  /** 全模型合计剩余百分比（0–100 取整）。 */
  readonly remainingPercent: number;
  /** 各模型明细（当前厂商可用模型 ∪ 当日有消耗的模型）。 */
  readonly models: readonly QuotaModelRow[];
  /** 本地自然日键（`YYYY-MM-DD`）。 */
  readonly dayKey: string;
  /** 本日重置时刻（本地 23:59:59.999 的 ISO 串）。 */
  readonly resetAt: string;
  /**
   * 数据来源标注：恒为 `local-budget`。
   * 面板必须显示该来源——这些数字来自本地 token 预算与本地用量记录，
   * **不是**厂商账户余额（OmniHarness 不持有厂商凭据之外的账户信息）。
   */
  readonly source: 'local-budget';
}

/** 配额服务依赖。 */
export interface QuotaDeps {
  /** 配额设置存储。 */
  readonly store: QuotaStore;
  /** 会话存档（按日聚合用量）。 */
  readonly usage: SessionArchive;
  /** 当前厂商可用模型清单（`model.catalog` 的 active.models）。 */
  readonly models: () => readonly string[];
  /** 时钟（注入便于单测固定「今天」）；缺省取系统当前时间。 */
  readonly now?: () => Date;
}

/**
 * 配额服务：把「本地日内 token 预算 − 今日已用」算成 UI 可直接渲染的余额面板数据。
 *
 * 为什么按模型分行：同一天里用户常在不同模型间切换（主力模型 + 廉价模型），
 * 合并成一根进度条会让「廉价款还剩很多、主力款已用光」这种关键状态不可见。
 *
 * 为什么额度按（基础预算 × 档位倍率）对每个模型**各自**计：档位是「可用总量」的倍数，
 * 不是「多给一个池子」；换算到单模型上就是同一个额度，语义最直白、也最难产生歧义。
 */
export class QuotaService {
  /** 档位目录：按名称查档位倍率，同时充当档位合法性校验来源。 */
  private readonly plans = new QuotaPlans();

  /**
   * @param deps 设置存储 / 用量来源 / 模型清单 / 时钟
   */
  public constructor(private readonly deps: QuotaDeps) {}

  /**
   * 读当前配额状态。
   * @returns 档位、额度、各模型已用与剩余
   */
  public status(): QuotaStatus {
    const settings = this.deps.store.read();
    const plan = this.plans.of(settings.plan);
    const effectiveTokens = Math.floor(settings.dailyTokens * plan.multiplier);
    const day = this.today();
    const used = this.safeDailyUsage(day);
    const names = this.modelNames(used.byModel);
    const rows: QuotaModelRow[] = names.map((name) => {
      const modelUsed = used.byModel[name] ?? 0;
      return {
        name,
        used: modelUsed,
        limit: effectiveTokens,
        remainingPercent: remaining(effectiveTokens - modelUsed, effectiveTokens),
      };
    });
    // 合计口径：每个模型各有一份额度，故总额度 = 单份额度 × 模型数（无模型时至少算一份，
    // 否则 fresh 环境下总量分母为 0、剩余率恒 0，面板一上来就显示「已用光」）。
    const totalLimit = effectiveTokens * Math.max(1, rows.length);
    return {
      plan,
      dailyTokens: settings.dailyTokens,
      effectiveTokens,
      usedTokens: used.total,
      remainingPercent: remaining(totalLimit - used.total, totalLimit),
      models: rows,
      dayKey: day.key,
      resetAt: day.endsAt,
      source: 'local-budget',
    };
  }

  /**
   * 更新配额设置。
   * @param params `{ plan?, dailyTokens? }`（未提供字段保持原值）
   * @returns 更新后的状态
   * @throws 档位非法或日预算非正数时抛错（fail-closed，经 RPC 原样回给 UI）
   */
  public update(params: { readonly plan?: string; readonly dailyTokens?: number }): QuotaStatus {
    const patch: { plan?: string; dailyTokens?: number } = {};
    if (params.plan !== undefined) patch.plan = params.plan;
    if (params.dailyTokens !== undefined) patch.dailyTokens = params.dailyTokens;
    if (Object.keys(patch).length > 0) {
      this.deps.store.write(patch);
    }
    return this.status();
  }

  /**
   * 今日（本地自然日）。
   * @returns 以注入时钟（缺省系统时间）为基准的本地自然日
   */
  private today(): LocalDay {
    return new LocalDay(this.deps.now?.() ?? new Date());
  }

  /**
   * 读当日用量：存档不可读时退化为零用量（面板显示满额，好过报错阻断）。
   * @param day 目标本地自然日
   * @returns 按模型分组的当日用量与合计（退化时各模型用量为空、合计为 0）
   */
  private safeDailyUsage(day: LocalDay): { byModel: Record<string, number>; total: number } {
    try {
      return this.deps.usage.dailyUsage(day);
    } catch {
      return { byModel: {}, total: 0 };
    }
  }

  /**
   * 合并「当前可用模型清单」与「当日实际有消耗的模型」并去重：
   * 只看清单会漏掉刚被切走的模型（它今天确实花了额度）；只看用量则无法预告未用模型。
   * @param usedByModel 当日各模型已用 token（来自用量存档，含未知模型）
   * @returns 去重后的模型名清单（先清单后用量的插入顺序）
   */
  private modelNames(usedByModel: Record<string, number>): string[] {
    const names = new Set<string>();
    for (const name of this.deps.models()) {
      if (name !== '') names.add(name);
    }
    for (const name of Object.keys(usedByModel)) {
      names.add(name);
    }
    return [...names];
  }
}

/** 剩余百分比（0–100 取整；额度非正时返回 0）。 */
function remaining(available: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  if (available <= 0) return 0;
  return Math.min(100, Math.round((available / limit) * 100));
}
