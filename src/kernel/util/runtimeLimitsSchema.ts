/**
 * 运维限制的**结构定义**（段 → 键 → 合法区间 + 数据文件的记录字段）。
 *
 * ## 为什么从 `runtimeLimits.ts` 拆出来
 *
 * 2026-10-30 P9 之后 `RuntimeLimits` 类所在文件逼近「上帝类」门禁（codeLines > 500）。
 * 区间表本身是**数据**（不是解析逻辑），拆出来后类文件只留解析与校验行为；
 * 区间改动仍只改这一处（`runtimeLimits.ts` 与 `limitsConfigValidator.ts` 都从这里取）。
 *
 * ## 为什么区间留在代码而不是 `defaults/limits.json`
 *
 * 区间是**校验策略**（比如"保留数不得为 0"这种脚枪闸），不是随部署变化的出厂值；
 * 出厂值与环境变量名在数据文件里。
 */

/** 单段各键的合法区间（闭区间，整数）。 */
export interface LimitBound {
  readonly min: number;
  readonly max: number;
}

/** 限制段名（数据文件顶层键 / 配置段键）。 */
export type LimitSection =
  'http' | 'preview' | 'a2a' | 'tools' | 'media' | 'browser' | 'lsp' | 'maintenance';

/** 结构定义：段 → 键 → 合法区间。 */
export const LIMIT_SCHEMA: Readonly<Record<LimitSection, Readonly<Record<string, LimitBound>>>> =
  Object.freeze({
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
      maxPushConfigsPerTask: { min: 1, max: 100_000 },
      maxPushTasks: { min: 1, max: 1_000_000 },
      maxTasks: { min: 1, max: 1_000_000 },
      maxArtifactsPerTask: { min: 1, max: 100_000 },
      transportSendTimeoutMs: { min: 1, max: 600_000 },
      transportReadTimeoutMs: { min: 1, max: 600_000 },
      transportMaxBodyBytes: { min: 1_024, max: 67_108_864 },
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
export const LIMIT_ENTRY_KEYS: ReadonlySet<string> = new Set(['value', 'env', 'notes']);

/** 段名全集（按稳定顺序，供报错文案与判据共用）。 */
export const LIMIT_SECTIONS: readonly LimitSection[] = [
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
export const LIMIT_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
