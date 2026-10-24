/**
 * MCP OAuth 令牌存储（2026-10-22，P0-3 第四片）。
 *
 * `mcp auth` 把授权码换来的令牌写到 `~/.omniharness/mcp-tokens.json`（0600），
 * `McpAuthProvider` 在 oauth 配置下按 resource 读取。文件里只有令牌与必要元数据，
 * 不含 client_secret；损坏/未知版本按空处理，不阻断启动。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 一条持久化令牌。 */
export interface McpStoredToken {
  /** 访问令牌。 */
  readonly accessToken: string;
  /** 刷新令牌（若授权服务器给）。 */
  readonly refreshToken?: string | undefined;
  /** 绝对过期时间（毫秒）。 */
  readonly expiresAt: number;
  /** 令牌端点（后续 refresh 用）。 */
  readonly tokenEndpoint: string;
  /** 客户端标识。 */
  readonly clientId: string;
  /** 受保护资源（键）。 */
  readonly resource: string;
  /**
   * 授权服务器 issuer（RFC 8414/9207）。
   *
   * 2026-07-28 安全要求：凭据绑定到签发它的授权服务器，**不得**跨 issuer 复用。
   * 旧条目没有该字段 ⇒ 在要求 issuer 的路径上视为不可用（fail-closed，需重新授权）。
   */
  readonly issuer?: string | undefined;
  /** 申请的 scope。 */
  readonly scopes?: readonly string[] | undefined;
}

/** 文件形状。 */
interface StoreFile {
  readonly version: 1;
  readonly tokens: Record<string, McpStoredToken>;
}

/**
 * 令牌存储（原子写、0600、容量有界）。
 */
export class McpAuthTokenStore {
  /**
   * 缺省路径。
   * @returns 令牌文件绝对路径。
   */
  public static defaultPath(): string {
    return join(homedir(), '.omniharness', 'mcp-tokens.json');
  }

  /**
   * @param path 存储路径（测试注入）。
   */
  public constructor(private readonly path: string = McpAuthTokenStore.defaultPath()) {}

  /**
   * 读取指定 resource 的令牌。
   * @param resource 受保护资源标识。
   * @param issuer 期望的授权服务器 issuer（给出时，只返回 issuer 逐字匹配的令牌）。
   * @returns 令牌；不存在/损坏/issuer 不匹配为 undefined。
   */
  public get(resource: string, issuer?: string | undefined): McpStoredToken | undefined {
    const token = this.read()[resource];
    if (token === undefined) return undefined;
    if (issuer !== undefined && token.issuer !== issuer) return undefined;
    return token;
  }

  /**
   * 写入/覆盖令牌（原子 rename）。
   * @param token 令牌。
   * @returns 无返回值。
   */
  public set(token: McpStoredToken): void {
    const tokens = this.read();
    // 先删同键再加到末尾：保证「刚写入的这条」永远不会被容量淘汰误删。
    delete tokens[token.resource];
    for (const key of Object.keys(tokens)) {
      if (Object.keys(tokens).length < 50) break;
      delete tokens[key];
    }
    tokens[token.resource] = token;
    const file: StoreFile = {
      version: 1,
      tokens,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp-${String(process.pid)}`;
    writeFileSync(temp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
  }

  /**
   * 读取并校验文件（BOM/损坏/版本不符按空）。
   * @returns 合法令牌映射。
   */
  private read(): Record<string, McpStoredToken> {
    if (!existsSync(this.path)) return {};
    try {
      const raw = readFileSync(this.path, 'utf8').replace(/^\uFEFF/u, '');
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed.version !== 1 || typeof parsed.tokens !== 'object' || parsed.tokens === null) {
        return {};
      }
      const out: Record<string, McpStoredToken> = {};
      for (const [key, token] of Object.entries(parsed.tokens)) {
        if (
          typeof token === 'object' &&
          token !== null &&
          typeof token.accessToken === 'string' &&
          token.accessToken.trim() !== '' &&
          typeof token.expiresAt === 'number' &&
          Number.isFinite(token.expiresAt) &&
          typeof token.tokenEndpoint === 'string' &&
          typeof token.clientId === 'string' &&
          typeof token.resource === 'string' &&
          (token.issuer === undefined || typeof token.issuer === 'string') &&
          key === token.resource
        ) {
          out[key] = token;
        }
      }
      return out;
    } catch {
      return {};
    }
  }
}
