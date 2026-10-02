/**
 * 前端 Bearer 令牌解析：把服务端的 OMNI_SERVE_TOKEN 暴露给浏览器侧 RPC / SSE。
 *
 * OmniHarness Web 是零打包器、由服务端静态托管的原生 ESM，没有构建期注入令牌的通道，
 * 故令牌只能「运行时」取得：显式 set() 覆盖 > localStorage['omni.serveToken'] > URL ?token=。
 * 当服务端未启用令牌（回环默认）时 resolve() 返回空串，调用方据此跳过 Authorization。
 */

/** 只读存储的最小接口（避免依赖具体 DOM 类型，便于在非浏览器环境注入）。 */
interface KeyValueStore {
  getItem(key: string): string | null;
}

/** 浏览器全局的最小接口（仅在真实浏览器环境存在）。 */
interface BrowserGlobals {
  readonly localStorage?: KeyValueStore;
  readonly location?: { readonly search: string };
}

/** 前端鉴权令牌来源：解析应随请求发送的 Bearer 令牌。 */
export class AuthToken {
  /** 显式覆盖（运行时设置 / 测试注入）；null 表示未设置，回退到持久化来源。 */
  private override: string | null = null;

  /**
   * 显式设置令牌（覆盖所有其他来源）。
   * @param token 令牌原文；空串表示清除覆盖，回退到 localStorage / URL。
   * @returns 无返回值。
   */
  public set(token: string): void {
    this.override = token === '' ? null : token;
  }

  /**
   * 解析当前应随请求发送的 Bearer 令牌。
   * @returns 令牌原文；无配置时返回空串（调用方跳过 Authorization 头）。
   */
  public resolve(): string {
    if (this.override !== null) {
      return this.override;
    }
    const persisted = this.readPersisted();
    if (persisted !== null) {
      return persisted;
    }
    return this.readUrlToken();
  }

  /**
   * 从 localStorage 读持久化令牌。
   * @returns 令牌原文；不可用或缺失时返回 null。
   */
  private readPersisted(): string | null {
    const store = (globalThis as unknown as BrowserGlobals).localStorage;
    if (store === undefined || typeof store.getItem !== 'function') {
      return null;
    }
    try {
      return store.getItem('omni.serveToken');
    } catch {
      return null;
    }
  }

  /**
   * 从 URL 查询参数 ?token= 读令牌（用户启动服务时把 OMNI_SERVE_TOKEN 一并带入页面）。
   * @returns 令牌原文；不可用或缺失时返回空串。
   */
  private readUrlToken(): string {
    const loc = (globalThis as unknown as BrowserGlobals).location;
    if (loc === undefined || typeof loc.search !== 'string') {
      return '';
    }
    try {
      return new URLSearchParams(loc.search).get('token') ?? '';
    } catch {
      return '';
    }
  }
}

/** 组合根单例：Web 全站共用同一令牌来源。 */
export const authToken = new AuthToken();
