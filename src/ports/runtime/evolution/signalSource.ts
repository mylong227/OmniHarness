import type { TelemetryProvenance } from '../runtimeTelemetry/telemetryProvenance.js';

/**
 * 进化信号种类。
 *
 * - `failure`：生产运行中的摩擦（验证失败 / 约束触发），喂失败模式挖掘器（防再犯方向）；
 * - `success`：生产运行中的有效技能组合，喂相变固化器（组合密度方向）。
 */
export type EvolutionSignalKind = 'failure' | 'success';

/**
 * 进化信号（GEE Kernel ① ingest 环的数据契约）。
 *
 * 从生产运行数据（`RuntimeTelemetryPort` 的观测行 + 会话结局）提炼的最小决策单元：
 * 一条信号要么是「需要防再犯的失败」（携带可直接喂 `FailurePatternMiner` 的记录形状），
 * 要么是「值得固化的成功组合」（携带可直接喂 `CapabilityCrystallizer.observe` 的组合）。
 *
 * 纪律（沿遥测诚实边界）：只有 `provenance === 'production'` 的数据才允许成为信号；
 * seed-bootstrap / synthetic-lab 行**永不**入信号——进化不得从合成数据里自我感动。
 *
 * 端口不反向依赖实现域：`failure` 载荷与 `src/evolution/failurePatternMiner.ts` 的
 * `FailureRecord` 结构同形（结构化类型兼容），`success.combination` 与固化器
 * `observe(combination)` 直通。
 */
export interface EvolutionSignal {
  /** 信号种类。 */
  readonly kind: EvolutionSignalKind;
  /**
   * 聚类 / 密度主键：
   * - failure = 失败签名（`telemetry:<观测种类> × <算子>`，与挖掘器签名同构）；
   * - success = 组合键（成员去重升序 `'|'` 连接，与固化器 `comboKey` 同构）。
   */
  readonly key: string;
  /** 人类可读证据（单行，进审计与提案摘要）。 */
  readonly evidence: string;
  /** 数据来源（只认 production；见 {@link EvolutionSignal} 模块注释）。 */
  readonly provenance: TelemetryProvenance;
  /** failure 信号载荷（kind= failure 时非空）。 */
  readonly failure?:
    { readonly kind: string; readonly location: string; readonly message: string } | undefined;
  /** success 信号载荷：命中的技能组合（≥2 成员；kind=success 时非空）。 */
  readonly success?: { readonly combination: readonly string[] } | undefined;
}

/**
 * 进化信号源端口（GEE Kernel ① ingest 环）：从生产运行数据采集进化信号。
 *
 * 实现须**确定性**（同输入恒同信号序列）且**有界**（单次采集量有上限，绝不无界膨胀）；
 * 消费语义由实现自持（游标 / 去重），重复 `collect()` 不得重复出信号。
 */
export interface EvolutionSignalSourcePort {
  /** 采集自上次以来的新信号（按数据到达序；空数组 = 无新信号）。 */
  collect(): readonly EvolutionSignal[];
}
