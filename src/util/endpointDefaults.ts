import { builtinDefaults } from './builtinDefaults.js';

/** 单个模型适配器的兜底端点与凭据来源（`defaults/endpoints.json` 的记录形状）。 */
export interface ModelAdapterDefaults {
  /** 适配器标识（`--model-adapter` 取值）。 */
  readonly id: string;
  /** 兜底端点（未显式配置 baseUrl 时使用）。 */
  readonly baseUrl: string;
  /** 兜底模型名（未显式配置 model 时使用）。 */
  readonly model: string;
  /** 是否必须提供 API Key（本地 Ollama 等免 Key）。 */
  readonly requiresApiKey: boolean;
  /** API Key 的环境变量名（同时用于拼错误提示，改名后提示自动跟随）。 */
  readonly apiKeyEnv?: string;
  /** 端点环境变量名。 */
  readonly baseUrlEnv?: string;
  /** 模型名环境变量名。 */
  readonly modelEnv?: string;
  /** 维护说明（来源、为何这么配、与哪个预设不可合并）。 */
  readonly notes?: string;
}

/** 单个服务端点（`defaults/endpoints.json` 的记录形状）。 */
export interface ServiceEndpointDefaults {
  /** 端点标识（调用方按此字面量取用；拼错即抛错，不会静默回落）。 */
  readonly id: string;
  /** 地址或地址模板（`{port}` 由调用方代入）。 */
  readonly url: string;
  /** 可覆盖该端点的环境变量名（缺省表示无 env 旋钮）。 */
  readonly env?: string;
  /** 维护说明。 */
  readonly notes?: string;
}

/** 一条适配器在**给定环境变量表**下解析出的生效值。 */
export interface ResolvedAdapterDefaults {
  /** 适配器标识。 */
  readonly id: string;
  /** 生效端点：`baseUrlEnv` 有值则用它，否则用数据文件的 `baseUrl`。 */
  readonly baseUrl: string;
  /** 生效模型名：`modelEnv` 有值则用它，否则用数据文件的 `model`。 */
  readonly model: string;
  /** 生效 API Key：`apiKeyEnv` 有值则用它，否则 undefined。 */
  readonly apiKey: string | undefined;
  /** 是否必须提供 API Key。 */
  readonly requiresApiKey: boolean;
  /** API Key 的环境变量名（用于错误提示）。 */
  readonly apiKeyEnv?: string;
}

/** 适配器记录允许的 key 全集。 */
const ADAPTER_KEYS: ReadonlySet<string> = new Set([
  'id',
  'baseUrl',
  'model',
  'requiresApiKey',
  'apiKeyEnv',
  'baseUrlEnv',
  'modelEnv',
  'notes',
]);

/** 服务端点记录允许的 key 全集。 */
const SERVICE_KEYS: ReadonlySet<string> = new Set(['id', 'url', 'env', 'notes']);

/**
 * 内建**地址**默认值（`defaults/endpoints.json`）——把散落在实现里的端点字面量收成一份数据。
 *
 * ## 为什么（用户指令：不要在代码里硬编码，方便以后维护）
 *
 * 改之前同一组地址在实现里有多份副本且没有任何单一来源：
 * `cli/cliBuildConfig.buildModel` 与 `config/configBuilder.buildRouterAdapter` **各写了一遍**
 * `https://api.openai.com/v1` / `https://api.anthropic.com`（改一处漏一处），插件市场索引、
 * SWE-bench 的 GitHub 基址、浏览器 CDP 自检地址也都各自硬编码。企业换私有 registry / GitHub Enterprise
 * / 自建网关时，只能改代码重发。
 *
 * 现统一从数据文件读：**改数据不改代码**；按环境变化的那些另有环境变量旋钮（由数据里的 `env` 字段声明）。
 *
 * ## 与 `defaults/providers.json` 的分工
 *
 * - `providers.json`：**厂商目录**（UI 厂商卡片 / Key 探测 / 启用厂商），按厂商标识组织；
 * - `endpoints.json`：**适配器与服务端点的兜底值**（按适配器标识 / 服务标识组织）。
 *
 * 两者存在看似重复的值（如 openai 的端点），但服务的是不同语义层：厂商预设可被用户整体覆盖，
 * 而适配器兜底是「连厂商都没选」时的最后一道默认。合并会让「用户覆盖某厂商」意外改掉适配器兜底。
 *
 * ## fail-closed
 *
 * 数据文件缺失 / 结构非法 / 字段残缺一律抛错：地址静默变成空串会让请求打到错误的 endpoint，
 * 比直接启动失败更难查。按标识取端点时**未知 id 也抛错**（防止拼错后静默拿到 undefined）。
 */
export class EndpointDefaults {
  /** 适配器兜底表：适配器标识 → 记录。 */
  private readonly adapters: ReadonlyMap<string, ModelAdapterDefaults>;
  /** 服务端点表：服务标识 → 记录。 */
  private readonly services: ReadonlyMap<string, ServiceEndpointDefaults>;

  /**
   * @param raw `defaults/endpoints.json` 的原始内容（构造期逐条校验；非法即抛错）。
   * @throws Error 顶层结构非法、条目字段缺失/类型错误、id 重复时抛出
   */
  public constructor(raw: unknown) {
    const root = this.asRecord(raw, 'defaults/endpoints.json');
    this.adapters = this.parseAdapters(root['modelAdapters']);
    this.services = this.parseServices(root['services']);
  }

  /**
   * 按适配器标识取兜底记录。
   * @param id 适配器标识（`--model-adapter` 取值）。
   * @returns 记录；未知适配器返回 undefined（适配器名本身由 CLI 枚举校验，无需在此抛错）。
   */
  public adapterDefaults(id: string): ModelAdapterDefaults | undefined {
    return this.adapters.get(id);
  }

  /**
   * 解析某适配器在给定环境变量表下的**生效值**（env 覆盖数据文件）。
   * @param id 适配器标识。
   * @param env 环境变量表（缺省 `process.env`；测试可注入）。
   * @returns 生效端点 / 模型 / Key；未登记的适配器返回 undefined。
   */
  public resolveAdapter(
    id: string,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): ResolvedAdapterDefaults | undefined {
    const record = this.adapters.get(id);
    if (record === undefined) {
      return undefined;
    }
    return {
      id: record.id,
      baseUrl: this.envValue(env, record.baseUrlEnv) ?? record.baseUrl,
      model: this.envValue(env, record.modelEnv) ?? record.model,
      apiKey: this.envValue(env, record.apiKeyEnv),
      requiresApiKey: record.requiresApiKey,
      ...(record.apiKeyEnv === undefined ? {} : { apiKeyEnv: record.apiKeyEnv }),
    };
  }

  /**
   * 按服务标识取地址（含 `env` 字段声明的环境变量覆盖）。
   * @param id 服务标识（如 `pluginRegistryIndex`）。
   * @param env 环境变量表（缺省 `process.env`）。
   * @returns 生效地址（可能含 `{port}` 模板，由调用方代入）。
   * @throws Error 未登记的服务标识（拼错即红，不静默给 undefined）
   */
  public urlOf(
    id: string,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): string {
    const record = this.services.get(id);
    if (record === undefined) {
      throw new Error(
        `defaults/endpoints.json 未登记服务端点 "${id}"（已登记：${[...this.services.keys()].join(' / ')}）`,
      );
    }
    return this.envValue(env, record.env) ?? record.url;
  }

  /**
   * 解析 `modelAdapters` 段。
   * @param raw 原始值。
   * @returns 适配器表（id 唯一）。
   * @throws Error 结构或条目非法时抛出。
   */
  private parseAdapters(raw: unknown): ReadonlyMap<string, ModelAdapterDefaults> {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('defaults/endpoints.json 的 modelAdapters 应为非空数组');
    }
    const out = new Map<string, ModelAdapterDefaults>();
    raw.forEach((entry, index) => {
      const where = `defaults/endpoints.json modelAdapters[${index}]`;
      const record = this.asRecord(entry, where);
      this.rejectUnknownKeys(record, ADAPTER_KEYS, where);
      const id = this.requireToken(record['id'], `${where}.id`);
      this.rejectDuplicate(out, id, where);
      const requiresApiKey = record['requiresApiKey'];
      if (typeof requiresApiKey !== 'boolean') {
        throw new Error(`${where}.requiresApiKey 应为布尔值`);
      }
      out.set(id, {
        id,
        baseUrl: this.requireUrl(record['baseUrl'], `${where}.baseUrl`),
        model: this.requireText(record['model'], `${where}.model`),
        requiresApiKey,
        ...this.optionalToken(record, 'apiKeyEnv', where),
        ...this.optionalToken(record, 'baseUrlEnv', where),
        ...this.optionalToken(record, 'modelEnv', where),
        ...this.optionalText(record, 'notes', where),
      });
    });
    return out;
  }

  /**
   * 解析 `services` 段。
   * @param raw 原始值。
   * @returns 服务端点表（id 唯一）。
   * @throws Error 结构或条目非法时抛出。
   */
  private parseServices(raw: unknown): ReadonlyMap<string, ServiceEndpointDefaults> {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('defaults/endpoints.json 的 services 应为非空数组');
    }
    const out = new Map<string, ServiceEndpointDefaults>();
    raw.forEach((entry, index) => {
      const where = `defaults/endpoints.json services[${index}]`;
      const record = this.asRecord(entry, where);
      this.rejectUnknownKeys(record, SERVICE_KEYS, where);
      const id = this.requireToken(record['id'], `${where}.id`);
      this.rejectDuplicate(out, id, where);
      out.set(id, {
        id,
        url: this.requireText(record['url'], `${where}.url`),
        ...this.optionalToken(record, 'env', where),
        ...this.optionalText(record, 'notes', where),
      });
    });
    return out;
  }

  /**
   * 取环境变量值（空白视为未设置）。
   * @param env 环境变量表。
   * @param name 变量名（undefined ⇒ 未声明，直接返回 undefined）。
   * @returns 去空白后的值；未设置/空白为 undefined。
   */
  private envValue(
    env: Readonly<Record<string, string | undefined>>,
    name: string | undefined,
  ): string | undefined {
    if (name === undefined) {
      return undefined;
    }
    const raw = (env[name] ?? '').trim();
    return raw === '' ? undefined : raw;
  }

  /**
   * 断言为普通对象。
   * @param value 待判值。
   * @param where 报错定位。
   * @returns 收窄为 Record。
   * @throws Error 非普通对象时抛出。
   */
  private asRecord(value: unknown, where: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${where} 应为对象`);
    }
    return value as Record<string, unknown>;
  }

  /**
   * 拒绝未知 key（拼错字段被静默忽略最危险：会让默认值悄悄不生效）。
   * @param record 记录。
   * @param allowed 允许的 key 全集。
   * @param where 报错定位。
   * @returns 无返回值。
   * @throws Error 存在未知 key 时抛出。
   */
  private rejectUnknownKeys(
    record: Record<string, unknown>,
    allowed: ReadonlySet<string>,
    where: string,
  ): void {
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        throw new Error(`${where} 含未知 key '${key}'（允许：${[...allowed].join(' / ')}）`);
      }
    }
  }

  /**
   * 标识类字符串校验（非空、无空白）。
   * @param value 待校验值。
   * @param where 报错定位。
   * @returns 原字符串。
   * @throws Error 非字符串、空白或含空白时抛出。
   */
  private requireToken(value: unknown, where: string): string {
    if (typeof value !== 'string' || value.trim() === '' || /\s/.test(value)) {
      throw new Error(`${where} 应为非空且不含空白的字符串（当前 ${JSON.stringify(value)}）`);
    }
    return value;
  }

  /**
   * 文本类字符串校验（非空即可，允许内部空白与 `{port}` 模板）。
   * @param value 待校验值。
   * @param where 报错定位。
   * @returns 原字符串。
   * @throws Error 非字符串或全空白时抛出。
   */
  private requireText(value: unknown, where: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${where} 应为非空字符串（当前 ${JSON.stringify(value)}）`);
    }
    return value;
  }

  /**
   * URL 校验：`http(s)://` 或 `{port}` 模板形式。
   * @param value 待校验值。
   * @param where 报错定位。
   * @returns 原字符串。
   * @throws Error 形态非法时抛出。
   */
  private requireUrl(value: unknown, where: string): string {
    if (typeof value !== 'string' || !/^https?:\/\/\S+$/.test(value)) {
      throw new Error(`${where} 应为 http(s) 地址（当前 ${JSON.stringify(value)}）`);
    }
    return value;
  }

  /**
   * 可选标识字段（存在即校验）。
   * @param record 记录。
   * @param key 字段名。
   * @param where 报错定位。
   * @returns 收窄后的可选字段对象（缺省不写入，兼容 exactOptionalPropertyTypes）。
   * @throws Error 字段存在但非法时抛出。
   */
  private optionalToken(
    record: Record<string, unknown>,
    key: string,
    where: string,
  ): Record<string, string> {
    const value = record[key];
    return value === undefined ? {} : { [key]: this.requireToken(value, `${where}.${key}`) };
  }

  /**
   * 可选文本字段（存在即校验）。
   * @param record 记录。
   * @param key 字段名。
   * @param where 报错定位。
   * @returns 收窄后的可选字段对象。
   * @throws Error 字段存在但非法时抛出。
   */
  private optionalText(
    record: Record<string, unknown>,
    key: string,
    where: string,
  ): Record<string, string> {
    const value = record[key];
    return value === undefined ? {} : { [key]: this.requireText(value, `${where}.${key}`) };
  }

  /**
   * 拒绝重复标识。
   * @param seen 已收录的表。
   * @param id 本条标识。
   * @param where 报错定位。
   * @returns 无返回值。
   * @throws Error 标识重复时抛出。
   */
  private rejectDuplicate(seen: ReadonlyMap<string, unknown>, id: string, where: string): void {
    if (seen.has(id)) {
      throw new Error(`${where} 与前面的条目重复使用标识 "${id}"`);
    }
  }
}

/**
 * 默认实例（组合根单例）：数据在构造期读出并校验，缺文件 / 结构非法即当场抛错。
 */
export const endpointDefaults = new EndpointDefaults(builtinDefaults.json('endpoints'));
