/** 共振场引擎选项（合并原 resonance + memoryWeb 配置）。 */
export interface ResonantFieldOptions {
  /** 黏附半径（共振度阈值）：新事实与簇共振≥此值则黏附去重。默认 0.75。 */
  readonly adhesionThreshold?: number | undefined;
  /** Bekenstein 容量界：簇数硬上限，超限触发 RG 坍缩。默认 64。 */
  readonly bekensteinCap?: number | undefined;
  /** 纤维边阈值。默认 0.4。 */
  readonly edgeThreshold?: number | undefined;
  /** 本征谱分箱（须与记忆引擎一致）。默认 257。 */
  readonly bins?: number | undefined;
  /** 时间衰减半衰期（天）：recall 分数 = 相关性 × 0.5^(年龄/半衰期)。默认 90。 */
  readonly halfLifeDays?: number | undefined;
  /** 时钟（注入用，便于测试）；返回当前毫秒时间戳。默认 Date.now。 */
  readonly clock?: (() => number) | undefined;
}
