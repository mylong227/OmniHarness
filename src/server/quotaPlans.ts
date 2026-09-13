/**
 * 配额档位表：把「档位 id」映射为「配额倍率与展示名」。
 *
 * 定位说明（避免误读）：这是**本地日内 token 预算的档位**，不是厂商账户余额。
 * OmniHarness 不代持任何厂商账单，也无法读取端点侧的账户余额（各厂商均无稳定公开接口），
 * 因此「今日余额」一律由本地预算 × 档位倍率 − 今日实际用量算出，UI 必须如实标注来源。
 *
 * 倍率取整档位（1.0 / 1.5 / 3.0）而非任意小数：档位是产品语义，不是可调参数。
 */

/** 单个配额档位。 */
export interface QuotaPlan {
  /** 档位 id（落盘用，稳定不变）。 */
  readonly id: string;
  /** 展示名。 */
  readonly label: string;
  /** 配额倍率（相对基础日预算）。 */
  readonly multiplier: number;
  /** 是否为升级档（UI 显示「升级」徽标）。 */
  readonly upgraded: boolean;
  /** 是否为缺省档。 */
  readonly fallback: boolean;
}

/** 未配置 / 配置非法时使用的档位 id（模块级常量，避免类级 static）。 */
export const QUOTA_DEFAULT_ID = 'free';

/** 档位表。 */
export class QuotaPlans {
  private readonly plans: readonly QuotaPlan[] = [
    { id: 'free', label: '免费', multiplier: 1, upgraded: false, fallback: true },
    { id: 'plus', label: '升级', multiplier: 1.5, upgraded: true, fallback: false },
    { id: 'pro', label: '专业', multiplier: 3, upgraded: true, fallback: false },
  ];

  /**
   * 按 id 取档位。
   * @param id 档位 id（可能是未知值 / undefined，例如手改配置文件写错）
   * @returns 匹配档位；未知 id 回退缺省档（fail-soft：不抛错、不阻断面板加载）
   */
  public of(id: string | undefined): QuotaPlan {
    const found = this.plans.find((plan) => plan.id === id);
    return found ?? this.plans.find((plan) => plan.fallback)!;
  }

  /** 全部档位（UI 下拉用，顺序即展示顺序）。 */
  public all(): readonly QuotaPlan[] {
    return this.plans;
  }

  /**
   * 校验档位 id 是否合法（写盘前 fail-closed：非法档位拒绝落盘，不静默改写用户输入）。
   * @param id 候选档位 id
   * @returns 是否存在于档位表
   */
  public isValid(id: string): boolean {
    return this.plans.some((plan) => plan.id === id);
  }
}
