/**
 * 上下文窗口目录：由模型名解析「上下文窗口 token 数」。
 *
 * 用途单一——给容量面板提供百分比的分母（`已用 / 窗口`），并给压缩器阈值一个真实基准。
 * 因此本目录**必须偏保守**：宁可低估窗口（把占用算得更满，提前提示用户），
 * 也不要高估（让用户以为还有余量、结果被端点截断）。
 *
 * 解析优先级（高 → 低）：
 *  1. 显式传入的覆盖值（服务端读 env `OMNI_CONTEXT_WINDOW`）；
 *  2. 模型名子串表（按序匹配，先精确后模糊）；
 *  3. 缺省值（{@link ContextWindowCatalog.DEFAULT_WINDOW}）。
 *
 * 表里都是**公开规格的近似值**：同一模型名在不同厂商/不同版本上窗口可能不同，
 * 故此处只做量级判断（32k / 128k / 200k / 1M），不做精确承诺。
 */

/** 模型名子串 → 窗口 token 数（按数组顺序匹配，靠前者优先）。 */
const WINDOW_TABLE: readonly { readonly match: readonly string[]; readonly tokens: number }[] = [
  // 1M 级
  {
    match: ['gemini-1.5-pro', 'gemini-2.0', 'gemini-2.5', 'glm-5', 'qwen3-max'],
    tokens: 1_000_000,
  },
  // 200k 级
  {
    match: ['claude-3', 'claude-4', 'claude-sonnet', 'claude-opus', 'claude-haiku'],
    tokens: 200_000,
  },
  // 128k 级
  {
    match: [
      'gpt-4o',
      'gpt-4.1',
      'gpt-5',
      'o1',
      'o3',
      'o4-mini',
      'deepseek',
      'glm-4',
      'qwen',
      'kimi',
      'moonshot',
    ],
    tokens: 128_000,
  },
  // 32k 级
  { match: ['llama', 'local', 'mock'], tokens: 32_768 },
];

/** 上下文窗口目录。 */
export class ContextWindowCatalog {
  /** 无匹配时的缺省窗口（128k，主流兼容端点的常见下限）。 */
  public static readonly DEFAULT_WINDOW = 128_000;

  private readonly explicit: number | undefined;

  /**
   * @param explicit 显式覆盖窗口（通常来自 env `OMNI_CONTEXT_WINDOW`）；非法值视为未提供
   */
  public constructor(explicit?: number) {
    this.explicit = this.valid(explicit);
  }

  /**
   * 由模型名解析窗口大小。
   * @param model 模型名（可能为空串——未知模型回退缺省值）
   * @returns 窗口 token 数（恒为正整数）
   */
  public of(model: string): number {
    if (this.explicit !== undefined) return this.explicit;
    const name = model.toLowerCase();
    for (const entry of WINDOW_TABLE) {
      for (const needle of entry.match) {
        if (name.includes(needle)) return entry.tokens;
      }
    }
    return ContextWindowCatalog.DEFAULT_WINDOW;
  }

  /** 校验显式覆盖值：仅接受正的有限数，其余视为未提供（fail-soft，不抛错阻断启动）。 */
  private valid(value: number | undefined): number | undefined {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
    return Math.floor(value);
  }
}
