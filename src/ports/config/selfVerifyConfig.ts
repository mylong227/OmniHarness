/**
 * （P3）自验证回环配置：写源码后自动跑受限测试并回灌失败摘要。
 *
 * 默认全部保守：超时 120s、输出上限 256 KiB、冷却 60s、每会话最多 3 次、摘要 15 行。
 * `enabled === true` 后取命令的优先级：**显式 `command` 直接生效**（不受「仓库有测试症状」闸门约束）；
 * 未给 `command` 时由 `SelfVerifyCommandDetector` 从仓库证据推断；两者皆无则不启用（fail-closed）。
 */
export interface SelfVerifyConfig {
  /** 是否启用（默认 false）。 */
  readonly enabled: boolean;
  /** 测试命令（缺省 `npm test`）。 */
  readonly command?: string | undefined;
  /** 同一会话两次自验证的最小间隔（毫秒，默认 60000）。 */
  readonly cooldownMs?: number | undefined;
  /** 同一会话最多触发次数（默认 3）。 */
  readonly maxRunsPerSession?: number | undefined;
  /** 单次测试命令超时（毫秒，默认 120000）。 */
  readonly timeoutMs?: number | undefined;
  /** 单路输出缓冲上限（字节，默认 262144）。 */
  readonly maxOutputBytes?: number | undefined;
  /** 回灌摘要行数上限（默认 15）。 */
  readonly maxDigestLines?: number | undefined;
}

/** （Laya 战略线）决策引擎配置：本地 System-1 推理（choice/score/noul）替代 LLM 长推理做高频判断点。默认 off；生产开 shadow（仅观测）/ enforce（回灌 noul 预判）。质量信号非安全边界，全程 fail-open。 */
