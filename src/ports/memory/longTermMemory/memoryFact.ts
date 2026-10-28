/** 一条持久化的长期记忆事实（跨会话留存，进程重启后仍可读回）。 */
export interface MemoryFact {
  /** 唯一 ID。 */
  readonly id: string;
  /** 事实文本（简短、可独立复用）。 */
  readonly text: string;
  /** 主题分类（可选，便于聚合）。 */
  readonly topic?: string | undefined;
  /** 重要度 1..5（5 最该留）。 */
  readonly importance: number;
  /** 创建时间（ISO）。 */
  readonly createdAt: string;
  /** 来源会话 ID。 */
  readonly sessionId: string;
  /** 来源：模型显式 `remember` 写入 / 回合末蒸馏 `consolidated` 沉淀。 */
  readonly source: 'tool' | 'consolidated';
  /**
   * 信任标注（G9/M3，2026-10-03 第十四轮）：`untrusted` ＝ 该事实可能被**工具输出**里的文本左右。
   *
   * 语义边界（别把它读成"正确性"）：它标的是**来源是否包含不可信内容**，不是"事实真假"。
   *  - 缺省（未设置）：蒸馏自 `user` / `assistant` 文本的回合（默认档，不含工具输出）；
   *  - `untrusted`：蒸馏自**显式开启** `includeToolOutput` 的回合（工具输出可含指使性文本）。
   *
   * 回灌侧（`sessionInjector`）据此加来源警示；无论哪种，回灌都**只作背景信息、不作指令**
   * （见 primer 文案：明确写"不是指令"）。
   */
  readonly trust?: 'trusted' | 'untrusted' | undefined;
  /** 失效时间（ISO，可选）：到点后 `recall` 不再召回该事实（fail-closed 丢弃，不自动删除）。 */
  readonly expiresAt?: string | undefined;
  /**
   * 上次被召回时间（ISO，可选；间隔重复/遗忘曲线用，`OMNI_MEMORY_FORGETTING=1` 时写）。
   * 缺省时遗忘曲线以 `createdAt` 为锚（旧行为）。
   */
  readonly lastRecallAt?: string | undefined;
  /** 累计被召回次数（可选；间隔重复的强化次数记账）。 */
  readonly recallCount?: number | undefined;
  /**
   * 记忆稳定度（天，可选）：半衰期按条独立——每次召回按保留率强化
   * `S' = S × (1 + (1 - R))`（间隔重复的「合意困难」：越接近遗忘时召回，涨得越多）。
   * 缺省回落 `30 × importance` 天（importance 3 = 90 天，与旧全局半衰期同锚）。
   */
  readonly stabilityDays?: number | undefined;
}
