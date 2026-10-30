import { builtinDefaults } from './builtinDefaults.ts';

/**
 * 运维限制（**超时 / 连接数 / 体积上限**）的数据化解析器。
 *
 * ## 为什么（用户指令：把能配置化的硬编码改成配置数据）
 *
 * 这些值此前写死在实现里（`HttpServer` 构造函数直接 `headersTimeout = 30_000`、
 * `MAX_BODY_BYTES = 8 * 1024 * 1024`、预览源另一套 15s/30s/64）。它们全是**部署环境相关**的运维旋钮：
 * 慢网络要放宽收头时限、被扫要收紧连接数、大附件要抬请求体上限——改一次就得改代码重发，
 * 或者去翻哪个模块里写死了哪个数。
 *
 * 现收成一条链：`defaults/limits.json`（出厂默认 + 环境变量名）→ `omniharness.json` 的 `limits` 段
 * → 环境变量 → 消费者。**改数据不改代码**，用户侧另有配置文件与环境变量两档覆盖。
 *
 * ## 优先级（与 `endpoints.json` 同口径）
 *
 * **`omniharness.json` 的 `limits` 段 > 数据里 `env` 字段声明的环境变量 > 数据里的 `value`**。
 *
 * ## fail-closed（绝不静默回落到"更宽松"的口径）
 *
 * - 数据文件缺失 / 结构非法 / 缺键 / 未知键 / 越界：**构造期抛错**（随包缺数据必须响）；
 * - 环境变量设了但不是正整数：**抛错并点名变量**（写错了却静默用默认值，正是"以为调过、其实没生效"）；
 * - 配置文件里的值：由 `limitsConfigValidator` 在加载期拒绝（未知段 / 未知键 / 非整数 / 越界）。
 *
 * 唯一的"回退"是**完全没设**（undefined / 空串）时用数据里的 `value`——那才是默认值该起作用的场合。
 */

/** 一条内建限制记录（`defaults/limits.json` 的形状）。 */
export interface LimitEntry {
  /** 出厂默认值（正整数）。 */
  readonly value: number;
  /** 可覆盖该项的环境变量名（缺省表示没有 env 旋钮）。 */
  readonly env?: string;
  /** 维护说明（为什么是这个值、何时该改）。 */
  readonly notes?: string;
}

/** HTTP 主服务限制（`limits.http`）。 */
export interface HttpLimits {
  /** 收齐完整 HTTP 头的时限（毫秒）。 */
  readonly headersTimeoutMs: number;
  /** 收齐整段请求的时限（毫秒；SSE 响应阶段不受约束）。 */
  readonly requestTimeoutMs: number;
  /** 并发连接上限（个）。 */
  readonly maxConnections: number;
  /** 请求体总量上限（字节）。 */
  readonly maxBodyBytes: number;
  /** 静态资源缓存条数上限。 */
  readonly staticCacheMaxEntries: number;
  /** 静态资源缓存总字节上限。 */
  readonly staticCacheMaxBytes: number;
}

/** 工作区网页预览源限制（`limits.preview`）。 */
export interface PreviewLimits {
  /** 收头时限（毫秒）。 */
  readonly headersTimeoutMs: number;
  /** 整段请求时限（毫秒）。 */
  readonly requestTimeoutMs: number;
  /** 并发连接上限（个）。 */
  readonly maxConnections: number;
}

/** `omniharness.json` 的 `limits` 段（逐项可选：写了哪项就覆盖哪项）。 */
export interface RuntimeLimitsConfig {
  readonly http?: Partial<HttpLimits> | undefined;
  readonly preview?: Partial<PreviewLimits> | undefined;
}

/** 解析后的完整限制表（每段每项都有值）。 */
export interface ResolvedRuntimeLimits {
  readonly http: HttpLimits;
  readonly preview: PreviewLimits;
}

/** 限制段名（数据文件顶层键 / 配置段键）。 */
type LimitSection = 'http' | 'preview';

/** 单段各键的合法区间（闭区间，整数）。 */
interface LimitBound {
  readonly min: number;
  readonly max: number;
}

/**
 * 结构定义：段 → 键 → 合法区间。
 *
 * 区间是**校验策略**（不是出厂值），故留在代码里；出厂值与 env 名在数据文件里。
 */
const SCHEMA: Readonly<Record<LimitSection, Readonly<Record<string, LimitBound>>>> = Object.freeze({
  http: Object.freeze({
    headersTimeoutMs: { min: 1, max: 86_400_000 },
    requestTimeoutMs: { min: 1, max: 86_400_000 },
    maxConnections: { min: 1, max: 1_000_000 },
    maxBodyBytes: { min: 1_024, max: 1_073_741_824 },
    staticCacheMaxEntries: { min: 1, max: 100_000 },
    staticCacheMaxBytes: { min: 1_024, max: 1_073_741_824 },
  }),
  preview: Object.freeze({
    headersTimeoutMs: { min: 1, max: 86_400_000 },
    requestTimeoutMs: { min: 1, max: 86_400_000 },
    maxConnections: { min: 1, max: 100_000 },
  }),
});

/** 一段限制记录的允许 key 全集（数据文件里的字段）。 */
const ENTRY_KEYS: ReadonlySet<string> = new Set(['value', 'env', 'notes']);

/** 段名全集（按稳定顺序，供报错文案与判据共用）。 */
const SECTIONS: readonly LimitSection[] = ['http', 'preview'];

/** 环境变量名的合法形态（避免数据文件里写出 `undefined` 这类永远不会被读到的名字）。 */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** 运维限制的数据化实现（构造期读数据并校验；无状态之外只持不可变表）。 */
export class RuntimeLimits {
  /** `段.键` → 记录（构造期已逐条校验）。 */
  private readonly entries: ReadonlyMap<string, LimitEntry>;

  /**
   * @param raw `defaults/limits.json` 的原始内容（构造期逐条校验，非法即抛错）。
   * @throws Error 结构非法 / 缺键 / 未知键 / 越界 / env 名非法或重复时抛出
   */
  public constructor(raw: unknown) {
    this.entries = RuntimeLimits.parseData(raw);
  }

  /**
   * 解析**生效**限制表：配置 > 环境变量 > 数据默认值。
   * @param config `omniharness.json` 的 `limits` 段（缺省表示未配置）。
   * @param env 环境变量表（缺省 `process.env`；判据可注入）。
   * @returns 每段每项都有值的完整限制表。
   * @throws Error 配置项或环境变量的值不是合法整数 / 越界时抛出（绝不静默回落）
   */
  public resolve(
    config?: RuntimeLimitsConfig,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): ResolvedRuntimeLimits {
    return {
      http: this.resolveHttp(config?.http, env),
      preview: this.resolvePreview(config?.preview, env),
    };
  }

  /**
   * 出厂默认值（不读环境变量、不读配置）。
   * @returns 数据文件里的完整限制表。
   */
  public defaults(): ResolvedRuntimeLimits {
    return { http: this.resolveHttp(undefined, {}), preview: this.resolvePreview(undefined, {}) };
  }

  /**
   * 校验 `omniharness.json` 的 `limits` 段（供配置加载期 fail-closed 使用）。
   *
   * 只报**写错了**（结构 / 未知段 / 未知键 / 非整数 / 越界）；不在这里读环境变量——
   * env 的合法性由 {@link resolve} 在读取时点名报错。
   * @param raw 配置里的原始值（可能是 undefined）。
   * @returns 首个错误消息；合法时 `undefined`。
   */
  public static validateConfig(raw: unknown): string | undefined {
    if (raw === undefined) {
      return undefined;
    }
    if (!RuntimeLimits.isRecord(raw)) {
      return 'limits 应为对象（形如 {"http":{"headersTimeoutMs":45000}}）';
    }
    for (const section of Object.keys(raw)) {
      if (!(SECTIONS as readonly string[]).includes(section)) {
        return `limits 含未知段 '${section}'（允许：${SECTIONS.join(' / ')}）`;
      }
      const body = raw[section];
      if (!RuntimeLimits.isRecord(body)) {
        return `limits.${section} 应为对象`;
      }
      const bounds = SCHEMA[section as LimitSection];
      for (const [key, value] of Object.entries(body)) {
        if (!Object.prototype.hasOwnProperty.call(bounds, key)) {
          return `limits.${section} 含未知 key '${key}'（允许：${Object.keys(bounds).join(' / ')}）`;
        }
        const message = RuntimeLimits.rangeMessage(`limits.${section}.${key}`, value, bounds[key]);
        if (message !== undefined) {
          return message;
        }
      }
    }
    return undefined;
  }

  /**
   * 解析 http 段（逐键走 `value` 的优先级链）。
   * @param overrides 配置文件覆盖值。
   * @param env 环境变量表。
   * @returns 完整 http 限制。
   */
  private resolveHttp(
    overrides: Partial<HttpLimits> | undefined,
    env: Readonly<Record<string, string | undefined>>,
  ): HttpLimits {
    return {
      headersTimeoutMs: this.value('http', 'headersTimeoutMs', overrides?.headersTimeoutMs, env),
      requestTimeoutMs: this.value('http', 'requestTimeoutMs', overrides?.requestTimeoutMs, env),
      maxConnections: this.value('http', 'maxConnections', overrides?.maxConnections, env),
      maxBodyBytes: this.value('http', 'maxBodyBytes', overrides?.maxBodyBytes, env),
      staticCacheMaxEntries: this.value(
        'http',
        'staticCacheMaxEntries',
        overrides?.staticCacheMaxEntries,
        env,
      ),
      staticCacheMaxBytes: this.value(
        'http',
        'staticCacheMaxBytes',
        overrides?.staticCacheMaxBytes,
        env,
      ),
    };
  }

  /**
   * 解析 preview 段。
   * @param overrides 配置文件覆盖值。
   * @param env 环境变量表。
   * @returns 完整 preview 限制。
   */
  private resolvePreview(
    overrides: Partial<PreviewLimits> | undefined,
    env: Readonly<Record<string, string | undefined>>,
  ): PreviewLimits {
    return {
      headersTimeoutMs: this.value('preview', 'headersTimeoutMs', overrides?.headersTimeoutMs, env),
      requestTimeoutMs: this.value('preview', 'requestTimeoutMs', overrides?.requestTimeoutMs, env),
      maxConnections: this.value('preview', 'maxConnections', overrides?.maxConnections, env),
    };
  }

  /**
   * 取一项的生效值：配置 > 环境变量 > 数据默认值。
   * @param section 段名。
   * @param key 键名。
   * @param override 配置覆盖值（undefined = 未配）。
   * @param env 环境变量表。
   * @returns 生效整数。
   * @throws Error 配置值或环境变量非法时抛出（消息点名来源）
   */
  private value(
    section: LimitSection,
    key: string,
    override: number | undefined,
    env: Readonly<Record<string, string | undefined>>,
  ): number {
    if (override !== undefined) {
      return RuntimeLimits.assertValue(section, key, override, `limits.${section}.${key}`);
    }
    const entry = this.entries.get(`${section}.${key}`);
    if (entry === undefined) {
      // 构造期已保证完备；这里只防「表被外部改坏」的防御性分支。
      throw new Error(`defaults/limits.json 缺少 ${section}.${key}`);
    }
    if (entry.env === undefined) {
      return entry.value;
    }
    const raw = (env[entry.env] ?? '').trim();
    if (raw === '') {
      return entry.value;
    }
    return RuntimeLimits.assertValue(
      section,
      key,
      RuntimeLimits.envInteger(entry.env, raw),
      entry.env,
    );
  }

  /**
   * 环境变量值 → 整数（非整数直接点名报错，不静默回落）。
   * @param name 变量名。
   * @param raw 原始文本（已去空白、非空）。
   * @returns 解析出的整数（范围由 `assertValue` 再校验）。
   * @throws Error 不是整数时抛出
   */
  private static envInteger(name: string, raw: string): number {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      throw new Error(`环境变量 ${name} 应为整数（收到 "${raw}"）`);
    }
    return parsed;
  }

  /**
   * 断言取值落在该键的合法区间内。
   * @param section 段名。
   * @param key 键名。
   * @param value 待校验值。
   * @param origin 报错来源（配置路径或环境变量名）。
   * @returns 原值。
   * @throws Error 非整数 / 越界时抛出
   */
  private static assertValue(
    section: LimitSection,
    key: string,
    value: number,
    origin: string,
  ): number {
    const bounds = SCHEMA[section][key];
    const message = RuntimeLimits.rangeMessage(origin, value, bounds);
    if (message !== undefined) {
      throw new Error(message);
    }
    return value;
  }

  /**
   * 生成区间校验消息（合法返回 undefined）。
   * @param where 报错定位。
   * @param value 待校验值。
   * @param bounds 合法区间（undefined = 该键不存在）。
   * @returns 错误消息或 undefined。
   */
  private static rangeMessage(
    where: string,
    value: unknown,
    bounds: LimitBound | undefined,
  ): string | undefined {
    if (bounds === undefined) {
      return `${where} 不是已知限制项`;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return `${where} 应为整数（收到 ${JSON.stringify(value)}）`;
    }
    if (value < bounds.min || value > bounds.max) {
      return `${where} 应在 ${String(bounds.min)}～${String(bounds.max)} 之间（收到 ${String(value)}）`;
    }
    return undefined;
  }

  /**
   * 解析并校验数据文件。
   * @param raw 数据文件原始内容。
   * @returns `段.键` → 记录。
   * @throws Error 结构非法 / 缺键 / 未知段或键 / 越界 / env 名非法或重复时抛出
   */
  private static parseData(raw: unknown): ReadonlyMap<string, LimitEntry> {
    if (!RuntimeLimits.isRecord(raw)) {
      throw new Error('defaults/limits.json 应为对象（段名 → 键 → 记录）');
    }
    const out = new Map<string, LimitEntry>();
    const envNames = new Set<string>();
    for (const name of Object.keys(raw)) {
      if (!(SECTIONS as readonly string[]).includes(name)) {
        throw new Error(`defaults/limits.json 含未知段 '${name}'（允许：${SECTIONS.join(' / ')}）`);
      }
      const section = name as LimitSection;
      const body = raw[section];
      if (!RuntimeLimits.isRecord(body)) {
        throw new Error(`defaults/limits.json 的 ${section} 段应为对象`);
      }
      const bounds = SCHEMA[section];
      for (const [key, bound] of Object.entries(bounds)) {
        const where = `defaults/limits.json ${section}.${key}`;
        const record = body[key];
        if (record === undefined) {
          throw new Error(`${where} 缺失（数据文件必须给全每段的每个键）`);
        }
        out.set(`${section}.${key}`, RuntimeLimits.parseEntry(record, where, bound, envNames));
      }
      for (const key of Object.keys(body)) {
        if (!Object.prototype.hasOwnProperty.call(bounds, key)) {
          throw new Error(
            `defaults/limits.json 的 ${section} 含未知键 '${key}'（允许：${Object.keys(bounds).join(' / ')}）`,
          );
        }
      }
    }
    for (const section of SECTIONS) {
      if (!Object.prototype.hasOwnProperty.call(raw, section)) {
        throw new Error(`defaults/limits.json 缺少 ${section} 段`);
      }
    }
    return out;
  }

  /**
   * 解析单条记录。
   * @param raw 原始记录。
   * @param where 报错定位。
   * @param bounds 合法区间。
   * @param envNames 已见过的环境变量名（查重）。
   * @returns 记录。
   * @throws Error 字段非法时抛出
   */
  private static parseEntry(
    raw: unknown,
    where: string,
    bounds: LimitBound,
    envNames: Set<string>,
  ): LimitEntry {
    if (!RuntimeLimits.isRecord(raw)) {
      throw new Error(`${where} 应为对象（{ value, env?, notes? }）`);
    }
    for (const key of Object.keys(raw)) {
      if (!ENTRY_KEYS.has(key)) {
        throw new Error(`${where} 含未知字段 '${key}'（允许：${[...ENTRY_KEYS].join(' / ')}）`);
      }
    }
    const message = RuntimeLimits.rangeMessage(`${where}.value`, raw['value'], bounds);
    if (message !== undefined) {
      throw new Error(message);
    }
    const value = raw['value'] as number;
    const env = raw['env'];
    if (env !== undefined) {
      if (typeof env !== 'string' || !ENV_NAME.test(env)) {
        throw new Error(
          `${where}.env 应为形如 OMNI_XXX 的环境变量名（收到 ${JSON.stringify(env)}）`,
        );
      }
      if (envNames.has(env)) {
        throw new Error(`${where}.env 与其他限制项重复使用环境变量 ${env}`);
      }
      envNames.add(env);
    }
    const notes = raw['notes'];
    if (notes !== undefined && (typeof notes !== 'string' || notes.trim() === '')) {
      throw new Error(`${where}.notes 应为非空字符串`);
    }
    return {
      value,
      ...(env !== undefined ? { env } : {}),
      ...(notes !== undefined ? { notes } : {}),
    };
  }

  /**
   * 是否普通对象（排除数组 / null）。
   * @param value 待判值。
   * @returns 是普通对象时 true。
   */
  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

/**
 * 默认实例（组合根单例）：数据在构造期读出并校验，缺文件 / 结构非法即当场抛错。
 */
export const runtimeLimits = new RuntimeLimits(builtinDefaults.json('limits'));
