/**
 * MCP 2026-07-28 CacheableResult 策略（`ttlMs` + `cacheScope`）。
 *
 * 规范要求 `tools/list`、`prompts/list`、`resources/list`、`resources/read`、
 * `resources/templates/list`（以及 `server/discover`）返回缓存提示。默认值刻意保守：
 *  - 列表类 60s、`resources/read` 30s、`server/discover` 5min；
 *  - 全部 `private`（MCP 内容通常随授权上下文变化，默认不跨授权上下文共享）。
 *
 * `cacheScope:"public"` 只在调用方显式配置时使用（例如纯静态工具清单）。
 */
import type { McpCacheableResult } from '../ports/mcp/mcpProtocolTypes.ts';
import type { McpCacheOptions } from '../ports/mcp/mcpServerOptions.ts';
import { McpProtocol } from './mcpProtocol.ts';

/** 单个方法的缓存字段。 */
type CacheFields = McpCacheableResult;

/**
 * 缓存策略（不可变；构造函数收敛默认值与按方法覆盖）。
 */
export class McpCachePolicy {
  /** 缺省 TTL（毫秒）。 */
  public static readonly DEFAULT_TTL_MS = 60_000;
  /** 缺省缓存范围。 */
  public static readonly DEFAULT_SCOPE: 'public' | 'private' = 'private';
  /** 按方法的缺省覆盖。 */
  public static readonly DEFAULT_PER_METHOD: Readonly<Record<string, CacheFields>> = {
    [McpProtocol.METHOD_SERVER_DISCOVER]: { ttlMs: 300_000, cacheScope: 'public' },
    [McpProtocol.METHOD_RESOURCES_READ]: { ttlMs: 30_000, cacheScope: 'private' },
  };

  /** 未覆盖时的 TTL。 */
  private readonly defaultTtlMs: number;
  /** 未覆盖时的范围。 */
  private readonly defaultScope: 'public' | 'private';
  /** 按方法的最终字段表。 */
  private readonly methods = new Map<string, CacheFields>();

  /**
   * @param options 用户配置（缺省使用保守默认值）。
   */
  public constructor(options: McpCacheOptions = {}) {
    this.defaultTtlMs = McpCachePolicy.normalizeTtl(options.ttlMs, McpCachePolicy.DEFAULT_TTL_MS);
    this.defaultScope = options.cacheScope ?? McpCachePolicy.DEFAULT_SCOPE;
    for (const method of McpProtocol.CACHEABLE_METHODS) {
      const base = McpCachePolicy.DEFAULT_PER_METHOD[method] ?? {
        ttlMs: this.defaultTtlMs,
        cacheScope: this.defaultScope,
      };
      const override = options.perMethod?.[method];
      this.methods.set(method, {
        ttlMs: McpCachePolicy.normalizeTtl(override?.ttlMs, base.ttlMs),
        cacheScope: override?.cacheScope ?? base.cacheScope,
      });
    }
  }

  /**
   * 某方法是否可缓存。
   * @param method MCP 方法名。
   * @returns 可缓存为 true。
   */
  public isCacheable(method: string): boolean {
    return McpProtocol.CACHEABLE_METHODS.includes(method);
  }

  /**
   * 取某方法的缓存字段（非可缓存方法抛错，避免静默漏字段）。
   * @param method MCP 方法名。
   * @returns `{ttlMs, cacheScope}`。
   */
  public fieldsFor(method: string): CacheFields {
    const fields = this.methods.get(method);
    if (fields === undefined) {
      throw new Error(`MCP 方法 ${method} 不是 CacheableResult 方法`);
    }
    return { ...fields };
  }

  /**
   * 规整 TTL（非有限/负数回落缺省，规范要求 `>= 0`）。
   * @param value 用户值。
   * @param fallback 缺省值。
   * @returns 非负整数毫秒。
   */
  private static normalizeTtl(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
    return Math.trunc(value);
  }
}
