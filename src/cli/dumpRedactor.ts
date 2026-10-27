/**
 * `--dump-config` 的输出打码（2026-10-27，冒烟实测发现明文泄漏）。
 *
 * 背景：`--dump-config` 直接把 `CliArgs` 原样 `JSON.stringify` 到 stdout，于是 `apiKey`
 * **明文**出现在终端/日志/截图里；而本仓对凭据的既定口径是「UI 回传一律打码、原文不回显」
 * （`serverConfigStore` / `appServerState` 都有打码实现）。同一份数据两条出口两种口径，
 * 必有一条是错的——这条错在 CLI。
 *
 * 打码范围（宁可多遮）：
 * - 任何层级上**键名**像凭据的字段（`apiKey` / `token` / `secret` / `password` /
 *   `credential` / `authorization`）⇒ 值换成 {@link MASK}；
 * - `env` / `headers`：只遮**名字**像凭据的条目（保留 `PATH` 等非敏感值，便于排障）；
 * - `auth`：整块遮掉（MCP 认证配置里字段名因厂商而异，逐字段判断不可靠）。
 *
 * 边界：这是**输出层**打码，不是加密；`--dump-config` 本就用于本机排障，不做权限校验。
 * 若未来 dump 里出现新的凭据容器，必须同步扩展 {@link SECRET_CONTAINERS}。
 */
export class DumpRedactor {
  /** 打码后的占位文本（固定字面量，便于判据断言与用户识别）。 */
  public static readonly MASK = '<redacted>';

  /** 键名像凭据的判定（大小写不敏感）。 */
  private static readonly SECRET_KEY: RegExp =
    /(?:api[-_]?key|token|secret|password|credential|authorization)/iu;

  /** 整块遮掉的容器键（其内部字段名不可靠，逐字段判断会漏）。 */
  private static readonly SECRET_CONTAINERS: ReadonlySet<string> = new Set(['auth']);

  /** 只遮「名字像凭据」的条目的容器键（值本身多为字符串）。 */
  private static readonly FILTERED_CONTAINERS: ReadonlySet<string> = new Set(['env', 'headers']);

  /**
   * 递归打码。
   * @param value 任意可 JSON 序列化的值（通常为 `CliArgs`）。
   * @returns 打码后的深拷贝（原对象不被修改）。
   */
  public static redact(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => DumpRedactor.redact(entry));
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (DumpRedactor.SECRET_CONTAINERS.has(key)) {
        out[key] = DumpRedactor.MASK;
        continue;
      }
      if (DumpRedactor.FILTERED_CONTAINERS.has(key) && DumpRedactor.isRecord(entry)) {
        out[key] = DumpRedactor.filterSecretEntries(entry);
        continue;
      }
      out[key] = DumpRedactor.SECRET_KEY.test(key) ? DumpRedactor.MASK : DumpRedactor.redact(entry);
    }
    return out;
  }

  /**
   * 容器内逐条判断：名字像凭据的值遮掉，其余原样保留。
   * @param record `env` / `headers` 这类键值表。
   * @returns 新的键值表。
   */
  private static filterSecretEntries(record: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      out[key] = DumpRedactor.SECRET_KEY.test(key) ? DumpRedactor.MASK : DumpRedactor.redact(entry);
    }
    return out;
  }

  /**
   * 判断是否为普通键值记录（数组/null 不算）。
   * @param value 待判定的值。
   * @returns 是普通对象时为 true。
   */
  private static isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}
