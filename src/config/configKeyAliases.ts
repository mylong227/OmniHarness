/**
 * 配置键别名（snake/kebab → camelCase）的**唯一**实现。
 *
 * 为什么要独立成模块：`ConfigError.normalizeConfig` 与工作区信任闸都要把同一份原始配置
 * 归一化到标准键；若各写一份别名表，任何一边漏掉 `base_url`/`elevated_sandbox` 都会造成
 * 「实际加载了、信任决策却没看见」的绕过（2026-10-22 评审实测）。
 *
 * 本类**不 import 任何配置实现**，避免 `configError ↔ workspaceTrust` 的依赖环。
 */
export class ConfigKeyAliases {
  /** 原始键 → 标准键。 */
  public static readonly MAP: Readonly<Record<string, string>> = {
    model_adapter: 'modelAdapter',
    'model-adapter': 'modelAdapter',
    base_url: 'baseUrl',
    'base-url': 'baseUrl',
    api_key: 'apiKey',
    'api-key': 'apiKey',
    storage_adapter: 'storageAdapter',
    'storage-adapter': 'storageAdapter',
    storage_dir: 'storageDir',
    'storage-dir': 'storageDir',
    elevated_sandbox: 'elevatedSandbox',
    'elevated-sandbox': 'elevatedSandbox',
    max_steps: 'maxSteps',
    'max-steps': 'maxSteps',
    model_circuit_breaker: 'modelCircuitBreaker',
    'model-circuit-breaker': 'modelCircuitBreaker',
    model_circuit_breaker_threshold: 'modelCircuitBreakerThreshold',
    'model-circuit-breaker-threshold': 'modelCircuitBreakerThreshold',
    model_circuit_breaker_open_ms: 'modelCircuitBreakerOpenMs',
    'model-circuit-breaker-open-ms': 'modelCircuitBreakerOpenMs',
    // P5：成本预算（snake / kebab / 缩写别名）。
    cost_budget_usd: 'costBudgetUsd',
    'cost-budget-usd': 'costBudgetUsd',
    cost_budget: 'costBudgetUsd',
    'cost-budget': 'costBudgetUsd',
    cost_budget_on_exceed: 'costBudgetOnExceed',
    'cost-budget-on-exceed': 'costBudgetOnExceed',
    cost_budget_soft_ratio: 'costBudgetSoftRatio',
    'cost-budget-soft-ratio': 'costBudgetSoftRatio',
  };

  /**
   * 把原始键归一化为标准键（无别名时原样返回）。
   * @param rawKey 原始键。
   * @returns 标准键。
   */
  public static canonical(rawKey: string): string {
    return ConfigKeyAliases.MAP[rawKey] ?? rawKey;
  }
}
