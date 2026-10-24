/**
 * MRTR `requestState` 的完整性保护（2026-07-28）。
 *
 * 规范要求：若 `requestState` 影响授权/资源访问/业务逻辑，服务端 **MUST** 保护其完整性
 * （HMAC/AEAD）并拒绝验签失败的状态；本实现还绑定：
 *  - 方法名 + 请求参数摘要（防跨请求重放）；
 *  - 短 TTL（默认 5 分钟，防长期重放）。
 *
 * 客户端**必须**原样回传，不得解析；本类只在服务端使用。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** 密封后的状态载荷。 */
interface RequestStatePayload {
  /** 版本。 */
  readonly v: 1;
  /** 绝对过期时间（毫秒）。 */
  readonly exp: number;
  /** 绑定方法名。 */
  readonly method: string;
  /** 绑定请求参数摘要。 */
  readonly digest: string;
  /** 业务附加状态（live handler 提供，不得含 secret）。 */
  readonly data: unknown;
}

/** 打开结果。 */
export type RequestStateOpen =
  { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly reason: string };

/**
 * `requestState` 编解码器（HMAC-SHA256 + base64url）。
 */
export class McpRequestStateCodec {
  /** 默认状态有效期（5 分钟）。 */
  public static readonly DEFAULT_TTL_MS = 5 * 60 * 1000;

  /** 时钟注入。 */
  private readonly now: () => number;

  /**
   * @param secret HMAC 密钥（多实例须共享；不得为空）。
   * @param ttlMs 有效期（毫秒）。
   * @param now 时钟注入（测试用）。
   */
  public constructor(
    private readonly secret: string,
    private readonly ttlMs: number = McpRequestStateCodec.DEFAULT_TTL_MS,
    now: () => number = Date.now,
  ) {
    if (secret.trim() === '') {
      throw new Error('MCP requestState secret 不得为空（fail-closed）');
    }
    this.now = now;
  }

  /**
   * 生成请求参数摘要（稳定 JSON：对象键排序，数组顺序保留）。
   * @param value 任意可序列化值（通常为 `{name, arguments}`）。
   * @returns sha256 十六进制摘要。
   */
  public static digestOf(value: unknown): string {
    return createHmac('sha256', 'mcp-request-digest')
      .update(McpRequestStateCodec.stableStringify(value), 'utf8')
      .digest('hex');
  }

  /**
   * 密封状态。
   * @param method 绑定方法名。
   * @param digest 绑定参数摘要。
   * @param data 业务状态。
   * @returns `<base64url(payload)>.<base64url(hmac)>`。
   */
  public seal(method: string, digest: string, data: unknown): string {
    const payload: RequestStatePayload = {
      v: 1,
      exp: this.now() + this.ttlMs,
      method,
      digest,
      data,
    };
    const body = McpRequestStateCodec.base64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
    return `${body}.${this.sign(body)}`;
  }

  /**
   * 打开并校验状态（验签 → 方法/摘要绑定 → 过期）。
   * @param state 客户端回传的 `requestState`。
   * @param method 当前请求方法。
   * @param digest 当前请求参数摘要。
   * @returns 成功时的业务状态；失败时给出**不含敏感值**的原因。
   */
  public open(state: string, method: string, digest: string): RequestStateOpen {
    const separator = state.lastIndexOf('.');
    if (separator <= 0 || separator === state.length - 1) {
      return { ok: false, reason: 'requestState 格式非法' };
    }
    const body = state.slice(0, separator);
    const signature = state.slice(separator + 1);
    if (!this.verify(body, signature)) {
      return { ok: false, reason: 'requestState 验签失败（可能被篡改）' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'requestState 载荷不可解析' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, reason: 'requestState 载荷形状非法' };
    }
    const payload = parsed as Partial<RequestStatePayload>;
    if (payload.v !== 1) return { ok: false, reason: 'requestState 版本不支持' };
    if (payload.method !== method) return { ok: false, reason: 'requestState 与当前方法不匹配' };
    if (payload.digest !== digest) {
      return { ok: false, reason: 'requestState 与当前请求参数不匹配（拒绝跨请求重用）' };
    }
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      return { ok: false, reason: 'requestState 缺少有效期' };
    }
    if (payload.exp <= this.now()) return { ok: false, reason: 'requestState 已过期' };
    return { ok: true, data: payload.data };
  }

  /**
   * 计算签名。
   * @param body base64url 载荷。
   * @returns base64url HMAC。
   */
  private sign(body: string): string {
    return McpRequestStateCodec.base64Url(
      createHmac('sha256', this.secret).update(body, 'ascii').digest(),
    );
  }

  /**
   * 常量时间验签（长度不同直接失败）。
   * @param body 载荷。
   * @param signature 客户端给的签名。
   * @returns 合法为 true。
   */
  private verify(body: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(body), 'utf8');
    const actual = Buffer.from(signature, 'utf8');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /**
   * base64url 无填充。
   * @param bytes 原始字节。
   * @returns base64url 字符串。
   */
  private static base64Url(bytes: Buffer): string {
    return bytes.toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  }

  /**
   * 稳定 JSON 序列化（对象键递归排序；`undefined` 视作 `null`）。
   * @param value 任意值。
   * @returns 稳定字符串。
   */
  private static stableStringify(value: unknown): string {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) {
      return `[${value.map((entry) => McpRequestStateCodec.stableStringify(entry)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${McpRequestStateCodec.stableStringify(record[key])}`,
    );
    return `{${parts.join(',')}}`;
  }
}
