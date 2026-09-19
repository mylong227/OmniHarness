/**
 * 配置分层归一化与严格校验（#G6，对标 codex merge.rs / profile_toml.rs / strict_config.rs）。
 *
 * 零依赖、纯数据层：操作的是 `FileConfig`（纯可序列化配置），不触及任何端口对象。
 * 分层合并发生在文件配置层，端口对象的装配仍在 ConfigFactory 内进行。
 */

import type { FileConfig } from './configFile.js';
import { OmniError, ErrorCode } from '../omniError.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { permissionConfigValidator } from './permissionConfigValidator.js';

/** 配置严格校验错误（fail-closed：任何未知 key / 类型 / 枚举越界都抛此错误，拒绝含糊吞掉）。 */
export class ConfigError extends OmniError {
  public constructor(message: string) {
    super(ErrorCode.CONFIG_ERROR, `配置错误: ${message}`);
  }

  /**
   * validateEnumFields — module-level helper moved into ConfigError.
   * @param {FileConfig} cfg - cfg
   * @returns {void} - result
   */
  public static validateEnumFields(cfg: FileConfig): void {
    for (const [field, allowed] of Object.entries(ENUM_VALUES)) {
      const value = (cfg as Record<string, unknown>)[field];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new ConfigError(
          `"${field}" 取值 "${String(value)}" 非法，允许: ${allowed.join(' | ')}`,
        );
      }
    }
  }

  /**
   * validateStringFields — module-level helper moved into ConfigError.
   * @param {FileConfig} cfg - cfg
   * @returns {void} - result
   */
  public static validateStringFields(cfg: FileConfig): void {
    for (const field of STRING_FIELDS) {
      const value = (cfg as Record<string, unknown>)[field];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'string') {
        throw new ConfigError(`"${field}" 应为字符串，收到 ${typeof value}`);
      }
    }
  }

  /**
   * validateNumberFields — module-level helper moved into ConfigError.
   * @param {FileConfig} cfg - cfg
   * @returns {void} - result
   */
  public static validateNumberFields(cfg: FileConfig): void {
    for (const field of NUMBER_FIELDS) {
      const value = (cfg as Record<string, unknown>)[field];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new ConfigError(`"${field}" 应为正数，收到 ${String(value)}`);
      }
    }
  }

  /**
   * validateBooleanFields — module-level helper moved into ConfigError.
   * @param {FileConfig} cfg - cfg
   * @returns {void} - result
   */
  public static validateBooleanFields(cfg: FileConfig): void {
    for (const field of BOOLEAN_FIELDS) {
      const value = (cfg as Record<string, unknown>)[field];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'boolean') {
        throw new ConfigError(`"${field}" 应为布尔值，收到 ${typeof value}`);
      }
    }
  }

  /**
   * validateMcpServers — module-level helper moved into ConfigError.
   * @param {FileConfig} cfg - cfg
   * @returns {void} - result
   */
  public static validateMcpServers(cfg: FileConfig): void {
    const servers = (cfg as Record<string, unknown>).mcpServers;
    if (servers === undefined) {
      return;
    }
    if (!Array.isArray(servers)) {
      throw new ConfigError('mcpServers 应为数组');
    }
    for (const [index, server] of servers.entries()) {
      if (
        typeof server !== 'object' ||
        server === null ||
        typeof (server as Record<string, unknown>).name !== 'string' ||
        typeof (server as Record<string, unknown>).command !== 'string'
      ) {
        throw new ConfigError(`mcpServers[${index}] 需含字符串 name 与 command`);
      }
    }
  }

  /**
   * validateWorkspaces — module-level helper moved into ConfigError.
   * @param {FileConfig} cfg - cfg
   * @returns {void} - result
   */
  public static validateWorkspaces(cfg: FileConfig): void {
    const workspaces = (cfg as Record<string, unknown>).workspaces;
    if (workspaces === undefined) {
      return;
    }
    if (
      !Array.isArray(workspaces) ||
      workspaces.some((w) => typeof w !== 'string' || w.trim() === '')
    ) {
      throw new ConfigError('workspaces 需为非空字符串数组');
    }
  }

  /**
   * validateModelRouter — module-level helper moved into ConfigError.
   * @param {FileConfig} cfg - cfg
   * @returns {void} - result
   */
  public static validateModelRouter(cfg: FileConfig): void {
    const router = (cfg as Record<string, unknown>).modelRouter;
    if (router === undefined) {
      return;
    }
    if (
      typeof router !== 'object' ||
      router === null ||
      typeof (router as Record<string, unknown>).strategy !== 'string' ||
      !Array.isArray((router as Record<string, unknown>).entries)
    ) {
      throw new ConfigError('modelRouter 需含字符串 strategy 与数组 entries');
    }
  }

  /**
   * validateProviderKeys — module-level helper moved into ConfigError.
   * @param {FileConfig} cfg - cfg
   * @returns {void} - result
   */
  public static validateProviderKeys(cfg: FileConfig): void {
    const providerKeys = (cfg as Record<string, unknown>).providerKeys;
    if (providerKeys === undefined) {
      return;
    }
    if (typeof providerKeys !== 'object' || providerKeys === null || Array.isArray(providerKeys)) {
      throw new ConfigError('providerKeys 应为「厂商标识 → Key」对象');
    }
    for (const [vendor, key] of Object.entries(providerKeys)) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new ConfigError(`providerKeys["${vendor}"] 应为非空字符串`);
      }
    }
  }
}

/** 标准配置项及其允许值集合（用于枚举校验与未知 key 拦截）。 */
const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  modelAdapter: ['mock', 'openai', 'anthropic', 'responses'],
  storageAdapter: ['memory', 'jsonl', 'sqlite'],
  approval: ['auto', 'deny', 'rules', 'guardian', 'ask'],
  // 推理强度档位是厂商相关的（#B6 扩展，2026-09-08）：DeepSeek 7 档 / OpenAI 5 档 / Anthropic 空。
  // 此处列并集作为"全局合法值"，保证用户在不同厂商切换时旧配置不爆 configLayer；
  // 具体厂商的合法值由 openaiCompatibleModel.bodyOf 在拼 wire 时再次校验，
  // 不在该厂商列表里的值会被清空（避免端点 400 "unknown variant"）。
  reasoning: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  sandbox: ['passthrough', 'policy', 'restricted', 'landlock', 'seatbelt', 'bwrap', 'unshare'],
  escalation: ['deny', 'ask', 'auto'],
  elevatedSandbox: ['passthrough', 'policy', 'restricted'],
  // P5：成本预算耗尽行为（'fail' 硬阻断 / 'warn' 软预算仅观测）。
  costBudgetOnExceed: ['fail', 'warn'],
};

/** 允许的字符串字段（非枚举、非数字）。 */
const STRING_FIELDS: ReadonlySet<string> = new Set([
  'baseUrl',
  'apiKey',
  'model',
  'storageDir',
  'workspace',
  'pluginProfile',
  'extends',
]);

/** 允许的数字字段。 */
const NUMBER_FIELDS: ReadonlySet<string> = new Set([
  'maxSteps',
  'modelCircuitBreakerThreshold',
  'modelCircuitBreakerOpenMs',
  // P5：成本预算（USD）与软阈值比例（相对硬预算，0<r≤1）。
  'costBudgetUsd',
  'costBudgetSoftRatio',
]);

/** 允许的布尔字段。 */
const BOOLEAN_FIELDS: ReadonlySet<string> = new Set([
  'longTermMemoryEncryption',
  'modelCircuitBreaker',
]);

/** 已知标准 key 全集（未知 key 一律报错）。 */
const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(ENUM_VALUES),
  ...STRING_FIELDS,
  ...NUMBER_FIELDS,
  ...BOOLEAN_FIELDS,
  'mcpServers',
  'elevatedSandbox',
  'longTermMemoryKeyFile',
  'modelRouter',
  'providerKeys',
  'workspaces',
  'permission',
  'evolutionRlvr',
  'a2a',
]);

/** key 别名 → 标准 key（下划线/连字符变体，对标 codex 的 key 别名归一化）。 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
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

/** 环境变量前缀与映射（OMNIHARNESS_MODEL → model）。 */
const ENV_MAP: Readonly<Record<string, string>> = {
  OMNIHARNESS_MODEL_ADAPTER: 'modelAdapter',
  OMNIHARNESS_BASE_URL: 'baseUrl',
  OMNIHARNESS_API_KEY: 'apiKey',
  OMNIHARNESS_MODEL: 'model',
  OMNIHARNESS_STORAGE_ADAPTER: 'storageAdapter',
  OMNIHARNESS_STORAGE_DIR: 'storageDir',
  OMNIHARNESS_APPROVAL: 'approval',
  OMNIHARNESS_REASONING: 'reasoning',
  OMNIHARNESS_SANDBOX: 'sandbox',
  OMNIHARNESS_ESCALATION: 'escalation',
  OMNIHARNESS_ELEVATED_SANDBOX: 'elevatedSandbox',
  OMNIHARNESS_WORKSPACE: 'workspace',
  OMNIHARNESS_MAX_STEPS: 'maxSteps',
};

/** 把任意层原始对象归一化为标准 FileConfig（别名映射 + 类型/枚举校验 + 未知 key 拦截）。 */
export function normalizeConfig(raw: Record<string, unknown>): FileConfig {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    const key = KEY_ALIASES[rawKey] ?? rawKey;
    if (!KNOWN_KEYS.has(key)) {
      throw new ConfigError(`未知配置项 "${rawKey}"（标准名 "${key}" 不被支持）`);
    }
    out[key] = value;
  }
  validateConfig(out as FileConfig);
  return out as FileConfig;
}

/**
 * 校验枚举字段：存在则必须是字符串且落在该字段的允许集合内。
 *
 * @param cfg 已归一化的配置
 * @throws ConfigError 取值越界
 */

/**
 * 校验自由字符串字段：存在则必须是 string。
 *
 * @param cfg 已归一化的配置
 * @throws ConfigError 类型不符
 */

/**
 * 校验数字字段：存在则必须是有限正数。
 *
 * @param cfg 已归一化的配置
 * @throws ConfigError 类型不符或非正数
 */

/**
 * 校验布尔字段：存在则必须是 boolean。
 *
 * @param cfg 已归一化的配置
 * @throws ConfigError 类型不符
 */

/**
 * 校验 `mcpServers`：数组，每项需含字符串 `name` 与 `command`。
 *
 * @param cfg 已归一化的配置
 * @throws ConfigError 结构不符
 */

/**
 * 校验 `workspaces`：非空字符串数组。
 *
 * @param cfg 已归一化的配置
 * @throws ConfigError 结构不符
 */

/**
 * 校验 `modelRouter`：需含字符串 `strategy` 与数组 `entries`。
 *
 * @param cfg 已归一化的配置
 * @throws ConfigError 结构不符
 */

/**
 * 校验 `providerKeys`：形如「厂商标识 → 非空字符串」的对象。
 *
 * @param cfg 已归一化的配置
 * @throws ConfigError 结构不符
 */

/**
 * 字段校验器注册表：**顺序即报错优先级**。
 *
 * 拆分为按字段族的校验器，是为了让 `validateConfig` 只保留「按序执行」这一个职责
 * （门禁函数体上限 80 行）；新增字段族时在此登记即可。
 */
const FIELD_VALIDATORS: ReadonlyArray<(cfg: FileConfig) => void> = [
  ConfigError.validateEnumFields,
  ConfigError.validateStringFields,
  ConfigError.validateNumberFields,
  ConfigError.validateBooleanFields,
  ConfigError.validateMcpServers,
  ConfigError.validateWorkspaces,
  ConfigError.validateModelRouter,
  ConfigError.validateProviderKeys,
  // permission 段（A2）：校验逻辑在独立类内（避免本文件越「一文件一类」红线），
  // 此处以箭头注册项接入——抛出统一以 ConfigError 表达，保证 fail-closed 语义一致。
  (cfg: FileConfig): void => {
    const message = permissionConfigValidator.validate(cfg);
    if (message !== undefined) {
      throw new ConfigError(message);
    }
  },
];

/**
 * 严格校验已归一化配置的类型与枚举（未知 key 已在 normalize 阶段拦截）。
 *
 * @param cfg 已归一化的配置
 * @throws ConfigError 任一字段族校验失败（fail-closed）
 */
export function validateConfig(cfg: FileConfig): void {
  for (const validate of FIELD_VALIDATORS) validate(cfg);
}

/** 从环境变量读取配置层（OMNIHARNESS_* 映射为标准 key，数字字段做 coerce）。 */
export function readEnvConfig(): Partial<FileConfig> {
  const raw: Record<string, string> = {};
  for (const [envKey, stdKey] of Object.entries(ENV_MAP)) {
    const value = process.env[envKey];
    if (value !== undefined && value !== '') {
      raw[stdKey] = value;
    }
  }
  if (Object.keys(raw).length === 0) {
    return {};
  }
  // 环境变量值全是字符串，需先 coerce 数字字段再走 normalize。
  const coerced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    coerced[key] = NUMBER_FIELDS.has(key) ? Number(value) : value;
  }
  return normalizeConfig(coerced);
}

/** 多层合并：靠后层非零值覆盖靠前层（mcpServers 数组整体替换，不拼接）。 */
export function mergeConfigs(...layers: readonly Partial<FileConfig>[]): FileConfig {
  const result: Record<string, unknown> = {};
  for (const layer of layers) {
    if (layer === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
  }
  return result as FileConfig;
}

/**
 * 读取工作区 bundle 补丁层目录（`.omniharness/bundle-patches/*.json`），合并为单一 config 覆盖层。
 *
 * 由 `bundle unpack` 写出（G-E 5.2/5.3），使「用户覆盖层叠在 base 之上」在运行时真正生效：
 * 在 `loadLayered` 中插入于 profile 层之后、环境变量层之前（权限：> profile，< 显式 env）。
 * 每个补丁按标准 key 严格校验——未知 key / 类型 / 枚举越界一律跳过并告警，绝不 brick 整个配置。
 */
export function loadBundlePatchLayer(workspaceDir: string): Partial<FileConfig> {
  const dir = join(workspaceDir, '.omniharness', 'bundle-patches');
  if (!existsSync(dir)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) {
      continue;
    }
    let data: { patches?: Array<{ key: string; value: unknown }> };
    try {
      data = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
        patches?: Array<{ key: string; value: unknown }>;
      };
    } catch {
      process.stderr.write(`[omniharness] 无法解析 bundle 补丁层: ${file}（已跳过）\n`);
      continue;
    }
    for (const patch of data.patches ?? []) {
      if (typeof patch.key !== 'string') {
        continue;
      }
      // 逐 key 归一化校验：合法则应用，非法（未知 key / 类型错 / 枚举越界）跳过并告警。
      try {
        const single = normalizeConfig({ [patch.key]: patch.value });
        out[patch.key] = (single as Record<string, unknown>)[patch.key];
      } catch {
        process.stderr.write(
          `[omniharness] bundle 补丁层忽略非法配置项: ${patch.key}（来自 ${file}）\n`,
        );
      }
    }
  }
  return out as Partial<FileConfig>;
}
