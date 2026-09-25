/**
 * 配置分层归一化与严格校验（#G6，对标 codex merge.rs / profile_toml.rs / strict_config.rs）。
 *
 * 零依赖、纯数据层：操作的是 `FileConfig`（纯可序列化配置），不触及任何端口对象。
 * 分层合并发生在文件配置层，端口对象的装配仍在 ConfigFactory 内进行。
 */

import type { FileConfig } from './configFile.js';
import type { SkillEntry } from '../skill/skill.js';
import { MODEL_ADAPTER_IDS } from '../ports/model/modelAdapterId.js';
import { OmniError, ErrorCode } from '../omniError.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { permissionConfigValidator } from './permissionConfigValidator.js';
import { ssrfPolicyValidator } from './ssrfPolicyValidator.js';
import { providerPresetValidator } from './providerPresetValidator.js';

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

  /**
   * 校验 `skills`（受种技能池）：数组，每项含非空 name/description/instructions，可选 tags。
   *
   * 规则与 `--skills <file.json>` 共用 {@link normalizeSkillEntries}——两个入口一份校验，
   * 避免「文件能写、CLI 报错」这类因入口不同而分叉的判定。
   *
   * @param {FileConfig} cfg - cfg
   * @returns {void} - result
   */
  public static validateSkills(cfg: FileConfig): void {
    const skills = (cfg as Record<string, unknown>).skills;
    if (skills === undefined) {
      return;
    }
    // 校验与**归一化**一并落地（写回 cfg），而不是只校验不落地：
    // 配置里写 `name: " a "` 若只校验不裁剪，会通过校验却在 `SkillRegistry.match()` 里永远命中不了
    // ——技能名对不上文本，症状是「配了但从不生效」，属最难查的静默失效。
    // 归一化同时丢弃莫尔/固化等运行时字段（见 `SkillEntry`），避免配置伪造涌现/固化来源。
    (cfg as Record<string, unknown>).skills = ConfigError.normalizeSkillEntries(
      skills,
      'omniharness.json',
    );
  }

  /** 把任意层原始对象归一化为标准 FileConfig（别名映射 + 类型/枚举校验 + 未知 key 拦截）。 */
  public static normalizeConfig(raw: Record<string, unknown>): FileConfig {
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
    ConfigError.validateConfig(out as FileConfig);
    return out as FileConfig;
  }

  /**
   * 校验并归一化「声明式技能子集」（配置文件 `skills` 与 CLI `--skills <file.json>` 共用同一份规则）。
   *
   * 为什么必须共用：技能会**注入系统提示**（影响模型行为），所以每条技能都要求
   * `name` / `description` / `instructions` 三件齐全且非空；只写 name 的「空技能」会静默命中
   * 却不注入任何内容，属最难查的配置错误。同一来源内重名直接拒绝——`SkillRegistry.register`
   * 遇重名会抛「技能重复注册」，那是**装配期**的错，报错点离配置文件很远。
   *
   * @param raw 原始值（来自 JSON：数组或 `{ skills: [...] }`）。
   * @param source 诊断用的来源标识（如 `omniharness.json` 或 `--skills <path>`）。
   * @returns 规范化后的技能子集（`tags` 缺省不写入；未声明的运行时字段一律丢弃）。
   * @throws ConfigError 结构/字段/重名任一不合法（fail-closed，绝不半途放行）
   */
  public static normalizeSkillEntries(raw: unknown, source: string): readonly SkillEntry[] {
    const list =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'skills' in raw
        ? (raw as { skills?: unknown }).skills
        : raw;
    if (list === undefined) {
      return [];
    }
    if (!Array.isArray(list)) {
      throw new ConfigError(
        `${source}: skills 必须是数组（每项含 name/description/instructions，可选 tags）`,
      );
    }
    const out: SkillEntry[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      const where = `${source}: skills[${i}]`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ConfigError(`${where} 必须是对象（含 name/description/instructions）`);
      }
      const obj = entry as Record<string, unknown>;
      const name = ConfigError.requiredText(obj['name'], `${where}.name`);
      const description = ConfigError.requiredText(obj['description'], `${where}.description`);
      const instructions = ConfigError.requiredText(obj['instructions'], `${where}.instructions`);
      const tags = ConfigError.readTags(obj['tags'], `${where}.tags`);
      if (seen.has(name)) {
        throw new ConfigError(`${source}: 技能重名 "${name}"（同一来源内不允许重复定义）`);
      }
      seen.add(name);
      out.push(
        tags === undefined
          ? { name, description, instructions }
          : {
              name,
              description,
              instructions,
              tags,
            },
      );
    }
    return out;
  }

  /**
   * 取必填非空字符串字段。
   *
   * @param value 原始值。
   * @param where 诊断位置（如 `skills[0].name`）。
   * @returns 去空白后的文本。
   * @throws ConfigError 缺失/非字符串/全空白
   */
  public static requiredText(value: unknown, where: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConfigError(`${where} 必须是非空字符串`);
    }
    return value.trim();
  }

  /**
   * 读取可选 `tags`（字符串数组，逐项去空白；空串项被丢弃）。
   *
   * @param value 原始值（undefined 表示未声明）。
   * @param where 诊断位置。
   * @returns 非空标签数组；未声明或全为空串时返回 undefined（不写入该键）。
   * @throws ConfigError 非数组或含非字符串项
   */
  public static readTags(value: unknown, where: string): readonly string[] | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string')) {
      throw new ConfigError(`${where} 必须是字符串数组`);
    }
    const tags = (value as readonly string[]).map((tag) => tag.trim()).filter((tag) => tag !== '');
    return tags.length > 0 ? tags : undefined;
  }

  /**
   * 严格校验已归一化配置的类型与枚举（未知 key 已在 normalize 阶段拦截）。
   *
   * @param cfg 已归一化的配置
   * @throws ConfigError 任一字段族校验失败（fail-closed）
   */
  public static validateConfig(cfg: FileConfig): void {
    for (const validate of FIELD_VALIDATORS) validate(cfg);
  }

  /** 从环境变量读取配置层（OMNIHARNESS_* 映射为标准 key，数字字段做 coerce）。 */
  public static readEnvConfig(): Partial<FileConfig> {
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
    return ConfigError.normalizeConfig(coerced);
  }

  /** 多层合并：靠后层非零值覆盖靠前层（mcpServers 数组整体替换，不拼接）。 */
  public static mergeConfigs(...layers: readonly Partial<FileConfig>[]): FileConfig {
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
  public static loadBundlePatchLayer(workspaceDir: string): Partial<FileConfig> {
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
          const single = ConfigError.normalizeConfig({ [patch.key]: patch.value });
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
}

/** 标准配置项及其允许值集合（用于枚举校验与未知 key 拦截）。 */
const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  // 适配器白名单来自端口层的唯一清单（`ports/model/modelAdapterId.ts`）——此前这里手写一份，
  // 且曾漏掉 `llamacpp`（`FileConfig` 类型与 CLI 枚举都早已包含它）⇒ 配置文件里写
  // `"modelAdapter": "llamacpp"` 被判非法（声明支持、校验拒绝），与 approval 的 'plan' 同型。
  // 直接展开清单后，这类漂移在编译期即不可发生。
  modelAdapter: [...MODEL_ADAPTER_IDS],
  storageAdapter: ['memory', 'jsonl', 'sqlite'],
  // 'plan' 是只读规划模式（写类工具一律拒绝）：`--approval plan` 与 `FileConfig.approval` 早已支持，
  // 且运行时确有处理（cliBuildConfig 的 planMode 分支、agentRuntimeHost 的 'plan' 覆盖），
  // 但**校验白名单漏了它** ⇒ 配置文件里写 "approval": "plan" 会被判非法（声明支持、校验拒绝）。
  // 2026-09-19 修正：与 CLI 枚举（cliEnums.APPROVALS）和 FileConfig 类型三处对齐。
  approval: ['auto', 'deny', 'rules', 'guardian', 'ask', 'plan'],
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
  'ssrfPolicy',
  'providerPresets',
  'evolutionRlvr',
  'a2a',
  'skills',
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
  ConfigError.validateSkills,
  // permission 段（A2）：校验逻辑在独立类内（避免本文件越「一文件一类」红线），
  // 此处以箭头注册项接入——抛出统一以 ConfigError 表达，保证 fail-closed 语义一致。
  (cfg: FileConfig): void => {
    const message = permissionConfigValidator.validate(cfg);
    if (message !== undefined) {
      throw new ConfigError(message);
    }
  },
  // ssrfPolicy 段（2026-09-22）：SSRF 策略表配置化——元数据主机 / 内网域名后缀 / IPv4 网段。
  // 校验与运行时解析器同源（`resolveSsrfPolicy`），非法条目一律拒绝而非静默丢弃。
  (cfg: FileConfig): void => {
    const message = ssrfPolicyValidator.validate(cfg);
    if (message !== undefined) {
      throw new ConfigError(message);
    }
  },
  // providerPresets 段（2026-09-22 第二轮）：厂商目录覆盖——按 id 整条替换内建预设 / 新 id 追加。
  // 校验与运行时求解器同源（`providerPresets.resolve`），非法条目一律拒绝而非静默丢弃。
  (cfg: FileConfig): void => {
    const message = providerPresetValidator.validate(cfg);
    if (message !== undefined) {
      throw new ConfigError(message);
    }
  },
];
