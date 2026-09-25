/**
 * Canonical 相关纯函数工具（C7 收口：原顶层内部函数迁入）。
 */
export class Canonical {
  /**
   * 确定性规范化基元（零依赖）。 动机（来自竞品调研的诚实缺口）： 上游 KV / prompt 缓存**只复用字节级公共前缀**——对象 key 顺序、时间戳、UUID、 临时路径等无语义抖动会让同一逻辑状态序列化成不同字节串，把缓存命中率打成 0。 Anthropic 官方数据：100k token 缓存提示 TTFT −79%、成本 −90%（见 docs 20 引用）。 但命中率**完全由 Harness 侧能否产出稳定前缀决定**，上游只提供能力不保证结果。 本模块提供把「逻辑状态 → 字节稳定表示」的规范映射，使前缀复用率可机械证明。
   * @param value unknown
   * @returns value is Record<string, unknown>
   */
  public static isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  /**
   * 递归规范化：对象 key 字典序排序、剔除 `undefined` 字段；**数组保序**（顺序即语义）。
   * 定律（可机械验证）：canonicalize ∘ canonicalize ≡ canonicalize（幂等）。
   */
  public static canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => Canonical.canonicalize(item));
    }
    if (Canonical.isPlainObject(value)) {
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        const field: unknown = source[key];
        if (field === undefined) {
          continue;
        }
        out[key] = Canonical.canonicalize(field);
      }
      return out;
    }
    return value;
  }

  /**
   * 稳定序列化：`JSON.stringify ∘ canonicalize`。
   * 保证「同一逻辑状态（含 key 顺序不同）→ 同一字节串」。
   */
  public static stableStringify(value: unknown): string {
    return JSON.stringify(Canonical.canonicalize(value));
  }

  /**
   * 擦除易变片段（时间戳 / UUID / 临时路径 / pid），替换为稳定占位符。
   * 用于让「内容不同但语义相同」的请求共享公共前缀。
   */
  public static scrubVolatile(text: string): string {
    let out = text;
    for (const [pattern, replacement] of VOLATILE_PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    return out;
  }
}

/** 易变片段的正则表：这些片段每次运行都不同，是缓存命中的头号杀手。 */
const VOLATILE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // ISO 8601 时间戳（含毫秒与时区）
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>'],
  // UUID v4
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>'],
  // 临时目录（跨平台）
  [/[/\\](?:tmp|temp)[/\\][^\s"'）)]*/gi, '<TMP>'],
  // 进程号
  [/\bpid[=: ]+\d+/gi, 'pid=<PID>'],
];
