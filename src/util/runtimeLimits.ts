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

/** A2A 互操作限制（`limits.a2a`）。 */
export interface A2aLimits {
  /** 委托/能力声明的挂起超时（毫秒）。 */
  readonly clientTimeoutMs: number;
  /** push notification 的 webhook 投递超时（毫秒）。 */
  readonly webhookTimeoutMs: number;
  /** `tasks/list` 缺省页大小（条；协议上限 100 是常量、不在此表）。 */
  readonly pageSize: number;
  /** 游标有效期（毫秒）。 */
  readonly pageTokenTtlMs: number;
}

/** 工具族缺省限额（`limits.tools`）。 */
export interface ToolsLimits {
  /** `web_fetch` 的缺省抓取超时（毫秒；调用参数仍可逐次覆盖）。 */
  readonly webFetchTimeoutMs: number;
  /** `web_fetch` 的缺省响应体字节上限（调用参数仍可逐次覆盖）。 */
  readonly webFetchMaxBytes: number;
  /** 前台 shell 并发上限（`FairSessionScheduler` 总槽位）。 */
  readonly shellConcurrency: number;
  /** 单会话 shell 排队上限。 */
  readonly shellQueuePerSession: number;
  /** 全部会话 shell 排队总上限。 */
  readonly shellQueueTotal: number;
}

/** 媒体抽帧限额（`limits.media`）。 */
export interface MediaLimits {
  /** ffmpeg/ffprobe 并发进程上限（超出排队，FIFO 补位）。 */
  readonly processConcurrency: number;
}

/** 维护巡检与保留策略（`limits.maintenance`）。 */
export interface MaintenanceLimits {
  /** 会话保留：永远保留最新的 N 组（配置段最低 1）。 */
  readonly keepNewest: number;
  /** 会话保留：超过该天数可删。 */
  readonly maxAgeDays: number;
  /** 会话存档总量上限（字节，超出按最旧淘汰）。 */
  readonly maxBytes: number;
  /** 临时目录清扫年龄阈值（毫秒）。 */
  readonly tmpOlderThanMs: number;
  /** serve 周期巡检间隔（小时）。 */
  readonly intervalHours: number;
}

/** LSP 代码导航限额（`limits.lsp`）。 */
export interface LspLimits {
  /** 单次 LSP 请求的等待超时（毫秒）。 */
  readonly requestTimeoutMs: number;
  /** 等待 `publishDiagnostics` 推送的超时（毫秒）。 */
  readonly diagnosticsTimeoutMs: number;
}

/** 浏览器（CDP / Playwright）限额（`limits.browser`）。 */
export interface BrowserLimits {
  /** Playwright 动作（click/fill/wait_for 等）的缺省超时（毫秒）。 */
  readonly actionTimeoutMs: number;
  /** 页面加载等待超时（毫秒）。 */
  readonly loadTimeoutMs: number;
  /** 单条 CDP 命令超时（毫秒）。 */
  readonly commandTimeoutMs: number;
  /** CDP WebSocket 建连超时（毫秒）。 */
  readonly connectTimeoutMs: number;
  /** 等浏览器 DevTools 端点就绪的启动超时（毫秒）。 */
  readonly launchTimeoutMs: number;
  /** 浏览器可用性探测超时（毫秒）。 */
  readonly probeTimeoutMs: number;
  /** `browser_screenshot` / `browser_act` 的空闲自动关闭定时器（毫秒）。 */
  readonly idleCloseMs: number;
}

/** `omniharness.json` 的 `limits` 段（逐项可选：写了哪项就覆盖哪项）。 */
export interface RuntimeLimitsConfig {
  readonly http?: Partial<HttpLimits> | undefined;
  readonly preview?: Partial<PreviewLimits> | undefined;
  readonly a2a?: Partial<A2aLimits> | undefined;
  readonly tools?: Partial<ToolsLimits> | undefined;
  readonly media?: Partial<MediaLimits> | undefined;
  readonly browser?: Partial<BrowserLimits> | undefined;
  readonly lsp?: Partial<LspLimits> | undefined;
  readonly maintenance?: Partial<MaintenanceLimits> | undefined;
}

/** 解析后的完整限制表（每段每项都有值）。 */
export interface ResolvedRuntimeLimits {
  readonly http: HttpLimits;
  readonly preview: PreviewLimits;
  readonly a2a: A2aLimits;
  readonly tools: ToolsLimits;
  readonly media: MediaLimits;
  readonly browser: BrowserLimits;
  readonly lsp: LspLimits;
  readonly maintenance: MaintenanceLimits;
}

/** 限制段名（数据文件顶层键 / 配置段键）。 */
type LimitSection =
  'http' | 'preview' | 'a2a' | 'tools' | 'media' | 'browser' | 'lsp' | 'maintenance';

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
  a2a: Object.freeze({
    clientTimeoutMs: { min: 1, max: 86_400_000 },
    webhookTimeoutMs: { min: 1, max: 600_000 },
    pageSize: { min: 1, max: 100 },
    pageTokenTtlMs: { min: 1, max: 2_592_000_000 },
  }),
  tools: Object.freeze({
    webFetchTimeoutMs: { min: 1, max: 300_000 },
    webFetchMaxBytes: { min: 1_024, max: 2_000_000 },
    shellConcurrency: { min: 1, max: 1_024 },
    shellQueuePerSession: { min: 1, max: 100_000 },
    shellQueueTotal: { min: 1, max: 1_000_000 },
  }),
  media: Object.freeze({
    processConcurrency: { min: 1, max: 256 },
  }),
  browser: Object.freeze({
    actionTimeoutMs: { min: 1, max: 600_000 },
    loadTimeoutMs: { min: 1, max: 600_000 },
    commandTimeoutMs: { min: 1, max: 600_000 },
    connectTimeoutMs: { min: 1, max: 600_000 },
    launchTimeoutMs: { min: 1, max: 600_000 },
    probeTimeoutMs: { min: 1, max: 600_000 },
    idleCloseMs: { min: 1_000, max: 86_400_000 },
  }),
  lsp: Object.freeze({
    requestTimeoutMs: { min: 1, max: 600_000 },
    diagnosticsTimeoutMs: { min: 1, max: 600_000 },
  }),
  maintenance: Object.freeze({
    // 配置段最低 1：把保留数调成 0 等于清空全部会话（env 旧语义不变，见数据文件 notes）。
    keepNewest: { min: 1, max: 1_000_000 },
    maxAgeDays: { min: 1, max: 36_500 },
    maxBytes: { min: 1_048_576, max: 1_099_511_627_776 },
    tmpOlderThanMs: { min: 60_000, max: 2_592_000_000 },
    intervalHours: { min: 1, max: 8_760 },
  }),
});

/** 一段限制记录的允许 key 全集（数据文件里的字段）。 */
const ENTRY_KEYS: ReadonlySet<string> = new Set(['value', 'env', 'notes']);

/** 段名全集（按稳定顺序，供报错文案与判据共用）。 */
const SECTIONS: readonly LimitSection[] = [
  'http',
  'preview',
  'a2a',
  'tools',
  'media',
  'browser',
  'lsp',
  'maintenance',
];

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
      a2a: this.resolveA2a(config?.a2a, env),
      tools: this.resolveTools(config?.tools, env),
      media: this.resolveMedia(config?.media, env),
      browser: this.resolveBrowser(config?.browser, env),
      lsp: this.resolveLsp(config?.lsp, env),
      maintenance: this.resolveMaintenance(config?.maintenance, env),
    };
  }

  /**
   * 出厂默认值（不读环境变量、不读配置）。
   * @returns 数据文件里的完整限制表。
   */
  public defaults(): ResolvedRuntimeLimits {
    return {
      http: this.resolveHttp(undefined, {}),
      preview: this.resolvePreview(undefined, {}),
      a2a: this.resolveA2a(undefined, {}),
      tools: this.resolveTools(undefined, {}),
      media: this.resolveMedia(undefined, {}),
      browser: this.resolveBrowser(undefined, {}),
      lsp: this.resolveLsp(undefined, {}),
      maintenance: this.resolveMaintenance(undefined, {}),
    };
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
   * 解析 a2a 段。
   * @param overrides 配置文件覆盖值。
   * @param env 环境变量表。
   * @returns 完整 a2a 限制。
   */
  private resolveA2a(
    overrides: Partial<A2aLimits> | undefined,
    env: Readonly<Record<string, string | undefined>>,
  ): A2aLimits {
    return {
      clientTimeoutMs: this.value('a2a', 'clientTimeoutMs', overrides?.clientTimeoutMs, env),
      webhookTimeoutMs: this.value('a2a', 'webhookTimeoutMs', overrides?.webhookTimeoutMs, env),
      pageSize: this.value('a2a', 'pageSize', overrides?.pageSize, env),
      pageTokenTtlMs: this.value('a2a', 'pageTokenTtlMs', overrides?.pageTokenTtlMs, env),
    };
  }

  /**
   * 解析 tools 段。
   * @param overrides 配置文件覆盖值。
   * @param env 环境变量表。
   * @returns 完整 tools 限额。
   */
  private resolveTools(
    overrides: Partial<ToolsLimits> | undefined,
    env: Readonly<Record<string, string | undefined>>,
  ): ToolsLimits {
    return {
      webFetchTimeoutMs: this.value(
        'tools',
        'webFetchTimeoutMs',
        overrides?.webFetchTimeoutMs,
        env,
      ),
      webFetchMaxBytes: this.value('tools', 'webFetchMaxBytes', overrides?.webFetchMaxBytes, env),
      shellConcurrency: this.value('tools', 'shellConcurrency', overrides?.shellConcurrency, env),
      shellQueuePerSession: this.value(
        'tools',
        'shellQueuePerSession',
        overrides?.shellQueuePerSession,
        env,
      ),
      shellQueueTotal: this.value('tools', 'shellQueueTotal', overrides?.shellQueueTotal, env),
    };
  }

  /**
   * 解析 media 段（ffmpeg 并发上限）。
   *
   * **env 语义**：`OMNI_MEDIA_PROCESS_CONCURRENCY` 仍由调用点的 `LimitEnv` 宽松解释
   * （写错回落默认），所以本段数据里的 `env` 字段只作**文档性声明**；配置段是严格层。
   * @param overrides 配置文件覆盖值。
   * @param env 环境变量表（本段不直接读 env，保留参数与其它段同形）。
   * @returns 完整 media 限额。
   */
  private resolveMedia(
    overrides: Partial<MediaLimits> | undefined,
    env: Readonly<Record<string, string | undefined>>,
  ): MediaLimits {
    return {
      processConcurrency: this.value(
        'media',
        'processConcurrency',
        overrides?.processConcurrency,
        env,
      ),
    };
  }

  /**
   * 解析 browser 段。
   * @param overrides 配置文件覆盖值。
   * @param env 环境变量表。
   * @returns 完整 browser 限额。
   */
  private resolveBrowser(
    overrides: Partial<BrowserLimits> | undefined,
    env: Readonly<Record<string, string | undefined>>,
  ): BrowserLimits {
    return {
      actionTimeoutMs: this.value('browser', 'actionTimeoutMs', overrides?.actionTimeoutMs, env),
      loadTimeoutMs: this.value('browser', 'loadTimeoutMs', overrides?.loadTimeoutMs, env),
      commandTimeoutMs: this.value('browser', 'commandTimeoutMs', overrides?.commandTimeoutMs, env),
      connectTimeoutMs: this.value('browser', 'connectTimeoutMs', overrides?.connectTimeoutMs, env),
      launchTimeoutMs: this.value('browser', 'launchTimeoutMs', overrides?.launchTimeoutMs, env),
      probeTimeoutMs: this.value('browser', 'probeTimeoutMs', overrides?.probeTimeoutMs, env),
      idleCloseMs: this.value('browser', 'idleCloseMs', overrides?.idleCloseMs, env),
    };
  }

  /**
   * 解析 lsp 段。
   * @param overrides 配置文件覆盖值。
   * @param env 环境变量表。
   * @returns 完整 lsp 限额。
   */
  private resolveLsp(
    overrides: Partial<LspLimits> | undefined,
    env: Readonly<Record<string, string | undefined>>,
  ): LspLimits {
    return {
      requestTimeoutMs: this.value('lsp', 'requestTimeoutMs', overrides?.requestTimeoutMs, env),
      diagnosticsTimeoutMs: this.value(
        'lsp',
        'diagnosticsTimeoutMs',
        overrides?.diagnosticsTimeoutMs,
        env,
      ),
    };
  }

  /**
   * 解析 maintenance 段。
   *
   * **注意**：维护旋钮的 env（`OMNI_GC_KEEP` / `OMNI_GC_MAX_AGE_DAYS` / `OMNI_GC_MAX_BYTES` /
   * `OMNI_MAINTENANCE_INTERVAL_HOURS`）**刻意不登记在本段**——它们由 `MaintenanceRunner` 按旧语义
   * 解释（写错忽略并回落默认，维护不许因一个坏环境变量停摆）。本方法只解析「数据默认值 + 配置覆盖」，
   * 环境变量由调用方在其上叠加（见 `maintenanceRunner.ts` 的层级注释）。
   * @param overrides 配置文件覆盖值。
   * @param env 环境变量表（本段数据未声明 env，故实际不参与解析）。
   * @returns 完整 maintenance 限制。
   */
  private resolveMaintenance(
    overrides: Partial<MaintenanceLimits> | undefined,
    env: Readonly<Record<string, string | undefined>>,
  ): MaintenanceLimits {
    return {
      keepNewest: this.value('maintenance', 'keepNewest', overrides?.keepNewest, env),
      maxAgeDays: this.value('maintenance', 'maxAgeDays', overrides?.maxAgeDays, env),
      maxBytes: this.value('maintenance', 'maxBytes', overrides?.maxBytes, env),
      tmpOlderThanMs: this.value('maintenance', 'tmpOlderThanMs', overrides?.tmpOlderThanMs, env),
      intervalHours: this.value('maintenance', 'intervalHours', overrides?.intervalHours, env),
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
