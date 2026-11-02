/**
 * 配额档位：**由当前模型自动识别**（2026-10-17 起）。
 *
 * ## 为什么不再让用户手选
 *
 * 旧实现把档位做成 `quota.json` 里的一个可写字段，面板上摆三个按钮（免费 / Plus / Pro）。
 * 三个问题：
 *   1. **它不是一个"选择"**：档位表达的是"你现在用的模型值多少额度"，而这件事由模型决定。
 *      让用户手选，等于让用户自己申报配额上限——额度就不再是约束，只是个显示数字。
 *   2. **两处真相**：模型在 Composer 里选，档位在容量面板里选，两者可以矛盾
 *      （用着旗舰模型却停在免费档，或反之）。
 *   3. **它是本地预算倍率，不是厂商账单**（见 `source: 'local-budget'`）：既然是本地口径，
 *      就更该按"本地已知的事实（模型名）"推导，而不是按"用户填的字段"。
 *
 * ## 现在的口径
 *
 * `QuotaPlans.forModel(model)`：按模型名匹配到档位。规则表**有序**（先匹配先赢），
 * 因为模型名里同时出现高级与轻量特征时（`gpt-4o-mini`、`deepseek-v4-pro-lite`），
 * 必须让"轻量"那一条先赢，否则一个 mini 会被判成旗舰档。
 *
 * 诚实边界：这是**命名启发式**，不是厂商提供的元数据（各厂商都没有"这个模型属于第几档"的公开接口）。
 * 判错时的后果只是本地日预算的倍率偏大或偏小（1× / 1.5× / 3×），不会影响真实计费——所以用启发式可接受，
 * 但每条规则的取值理由必须写在表里，便于之后按真实用量校准。
 */

/** 单个配额档位。 */
export interface QuotaPlan {
  /** 档位 id（稳定不变，前端按它取展示名）。 */
  readonly id: string;
  /** 展示名。 */
  readonly label: string;
  /** 配额倍率（相对基础日预算）。 */
  readonly multiplier: number;
  /** 是否为升级档（UI 显示「升级」徽标）。 */
  readonly upgraded: boolean;
}

/** 缺省档位 id：模型未知 / 未接入 / 本地模型都落这一档。 */
export const QUOTA_DEFAULT_ID = 'free';

/** 档位表：**顺序即从宽到紧**（首个匹配命中的即最终档位）。 */
const PLANS: readonly QuotaPlan[] = [
  { id: 'pro', label: '专业', multiplier: 3, upgraded: true },
  { id: 'plus', label: '升级', multiplier: 1.5, upgraded: true },
  { id: 'free', label: '免费', multiplier: 1, upgraded: false },
];

/** 档位 id → 档位（未知 id 回退 free）。 */
const BY_ID = new Map<string, QuotaPlan>(PLANS.map((p) => [p.id, p]));

/**
 * 一条识别规则：正则 + 目标档位 + 为什么这么判。
 *
 * 顺序即优先级。轻量特征（mini / flash / lite / nano / small / air）**必须排在旗舰特征之前**，
 * 否则 `gpt-4o-mini` 会被 `gpt-4o` 那条先吃走。
 */
interface PlanRule {
  readonly re: RegExp;
  readonly id: string;
  readonly why: string;
}

/** 轻量档特征（先匹配）：小模型、廉价档、本地模型。 */
const LIGHT_RULES: readonly PlanRule[] = [
  {
    re: /(?:^|[^a-z])(mini|nano|micro|tiny|small|lite|flash|air|turbo|fast|instant)(?:[^a-z]|$)/i,
    id: 'free',
    why: '名字里带轻量词（mini/nano/flash/lite/small/turbo…）⇒ 单次调用成本最低的那一档',
  },
  {
    // 本地/自托管：Ollama / llama.cpp / vLLM 之类，额度不该由本地预算卡住。
    re: /(?:^|[^a-z])(local|ollama|llama|llamacpp|vllm|qwen|phi|gemma|mistral-7b|yi-)/i,
    id: 'free',
    why: '本地/自托管模型，不产生厂商账单 ⇒ 不受本地日预算倍率约束',
  },
];

/** 旗舰档特征：强推理 / 顶配。 */
const PRO_RULES: readonly PlanRule[] = [
  {
    // OpenAI o 系列推理模型（o1 / o3 / o4 及其 mini 已被上面的轻量规则拦下）。
    re: /(?:^|[^a-z])o[1-9](?:[^a-z]|$)/i,
    id: 'pro',
    why: 'OpenAI o 系列（推理模型）按最高档计——它们的单次 token 消耗显著高于同代 chat 模型',
  },
  {
    re: /(?:^|[^a-z])(opus|sonnet-4|claude-4|gpt-5|gpt-4\.5|o3-pro)(?:[^a-z]|$)/i,
    id: 'pro',
    why: '旗舰命名（opus / sonnet-4 / claude-4 / gpt-5）',
  },
  {
    re: /(?:^|[^a-z])(4o|4\.1)(?:[^a-z]|$)/i,
    id: 'pro',
    why: 'GPT-4o / GPT-4.1 这一代旗舰 chat 模型',
  },
  {
    // 显式 pro / max / ultra / 不支持 mini 后缀的旗舰（deepseek-v4-pro、gemini-2.5-pro）。
    re: /(?:^|[^a-z])(pro|max|ultra|plus|premium|xhigh)(?:[^a-z]|$)/i,
    id: 'pro',
    why: '名字里带 pro/max/ultra/premium ⇒ 厂商自己标注的顶配档',
  },
  {
    re: /(?:^|[^a-z])(deepseek-reasoner|deepseek-v[0-9]+-pro|r1)(?:[^a-z]|$)/i,
    id: 'pro',
    why: '推理型主力模型（deepseek-reasoner / R1 / v<N>-pro）',
  },
];

/** 中档特征：主力通用模型（不是轻量，也不是旗舰）。 */
const PLUS_RULES: readonly PlanRule[] = [
  {
    re: /(?:^|[^a-z])(chat|general|standard|base|v[0-9]+)(?:[^a-z]|$)/i,
    id: 'plus',
    why: '通用主力命名（chat / standard / base / v<N>）——既非轻量也非旗舰，按中间档',
  },
];

/** 全部规则（顺序：轻量 → 旗舰 → 中档；先匹配先赢）。 */
const RULES: readonly PlanRule[] = [...LIGHT_RULES, ...PRO_RULES, ...PLUS_RULES];

/**
 * 档位目录 + 模型识别。
 *
 * 零依赖、纯函数式判定：`forModel()` 只吃一个模型名，便于在单测里逐条钉住规则优先级。
 */
export class QuotaPlans {
  /**
   * 按 id 取档位。
   * @param id 档位 id（未知 / undefined 回退缺省档，fail-soft：不抛错、不阻断面板加载）
   * @returns 匹配档位
   */
  public of(id: string | undefined): QuotaPlan {
    return (id !== undefined ? BY_ID.get(id) : undefined) ?? this.fallback();
  }

  /**
   * 缺省档位（free）。
   * @returns 缺省档
   */
  public fallback(): QuotaPlan {
    return BY_ID.get(QUOTA_DEFAULT_ID)!;
  }

  /**
   * **按模型名识别档位**（本模块的核心）。
   *
   * 判定顺序（顺序即语义，改动前先读上面 RULES 的注释）：
   *   1. 名字为空 / 未知 ⇒ 缺省档（free）；
   *   2. 命中轻量规则 ⇒ free；
   *   3. 命中旗舰规则 ⇒ pro；
   *   4. 命中中档规则 ⇒ plus；
   *   5. 都不命中 ⇒ 缺省档（free）——**宁可少给不可多给**：额度是约束，
   *      判不准时给最小倍率，用户若觉得被卡会主动去调基础日预算（那才是可调的那个量）。
   *
   * @param model 模型名（如 `deepseek-v4-pro` / `gpt-4o-mini`）
   * @returns 识别出的档位
   */
  public forModel(model: string | undefined): QuotaPlan {
    const name = (model ?? '').trim();
    if (name === '') return this.fallback();
    for (const rule of RULES) {
      if (rule.re.test(name)) return this.of(rule.id);
    }
    return this.fallback();
  }

  /**
   * 命中的规则说明（可解释性：面板要能告诉用户"为什么是这个档"）。
   * @param model 模型名
   * @returns 命中原因；未命中任何规则时为空串
   */
  public reasonFor(model: string | undefined): string {
    const name = (model ?? '').trim();
    if (name === '') return '';
    for (const rule of RULES) {
      if (rule.re.test(name)) return rule.why;
    }
    return '';
  }

  /**
   * 全部档位（从宽到紧；UI 展示档位阶梯时按此顺序）。
   * @returns 档位清单
   */
  public all(): readonly QuotaPlan[] {
    return PLANS;
  }

  /**
   * 校验档位 id 是否合法（`quota.set` 已不再接受 plan，本方法保留给需要校验的历史调用方）。
   * @param id 候选档位 id
   * @returns 是否存在于档位表
   */
  public isValid(id: string): boolean {
    return BY_ID.has(id);
  }

  /**
   * 从一组候选模型里挑出**代表模型**用于识别档位。
   *
   * 为什么需要它：`quota.get` 拿到的是一份模型清单（目录里的可用模型 ∪ 当日有消耗的模型），
   * 而档位是"整个会话的额度倍率"，必须落到**一个**模型上。口径：
   *   · 优先用当前生效模型（`active`）——它才是下一条消息真正会用的那个；
   *   · 否则用清单里识别出的**最高档**：清单里同时有 flash 与 pro 时，按 pro 给额度，
   *     避免"刚切到旗舰模型就被免费档卡住"；
   *   · 清单为空 ⇒ undefined（调用方落缺省档）。
   * @param models 候选模型清单
   * @returns 代表模型名（无候选时 undefined）
   */
  public representative(models: readonly string[]): string | undefined {
    const names = models.map((m) => m.trim()).filter((m) => m !== '');
    if (names.length === 0) return undefined;
    let best: { name: string; rank: number } | undefined;
    for (const name of names) {
      const rank = PLANS.findIndex((p) => p.id === this.forModel(name).id);
      // PLANS 顺序是从宽到紧（pro 在前）⇒ 下标越小档位越高。
      if (best === undefined || rank < best.rank) best = { name, rank };
    }
    return best?.name;
  }
}
