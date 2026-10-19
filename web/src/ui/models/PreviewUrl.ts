// 右栏网页预览的**地址判定**（纯静态、零 React、零 DOM 依赖，node 环境可直测）。
//
// 右栏要同时支持两类目标：
//   · 远端/本地已启动的服务：`http://localhost:5173`、`https://example.com/x`（原样进 iframe）；
//   · 工作区里写好的静态页面：`examples/site/index.html`（映射到预览源 `http://<host>:<port>/…`）。
//
// 本类只负责「输入文本 → iframe 可用 URL + 标签标题」，以及**安全判定**：
//   · 只接受 http(s)（`file:` / `javascript:` / `data:` 一律拒绝——它们能绕过预览源）；
//   · 工作区路径 fail-closed：绝对路径、`~`、盘符、含 `..` 段一律拒绝，不给越界读取留口子；
//   · 本地预览的 iframe 主机名**故意与 UI 不同**（`localhost` ↔ `127.0.0.1`）：会话 cookie 是
//     host-only + SameSite=Strict，换主机名后预览页带不上它。这条不变量写在这里，
//     而不是散落在组件里（改错就是静默的安全回退）。

/** 预览解析失败的机器可读原因（文案映射在控制器，便于 i18n 静态扫描）。 */
export type PreviewFailure = 'empty' | 'invalid' | 'outside' | 'no-preview' | 'no-host';

/** 解析上下文：UI 的主机名 + 预览源端口（未知为 null）。 */
export interface PreviewContext {
  /** 当前 UI 的 `location.hostname`（如 `127.0.0.1` / `localhost`）。 */
  readonly appHost: string;
  /** 预览源端口（`/healthz` 的 previewPort；未启用为 null）。 */
  readonly previewPort: number | null;
}

/** 解析成功的结果。 */
export interface PreviewTarget {
  /** iframe 的 src。 */
  readonly url: string;
  /** 右栏标签标题（主机名或文件名）。 */
  readonly title: string;
  /** `remote` 原样打开；`local` 工作区文件经预览源映射。 */
  readonly kind: 'remote' | 'local';
}

/** 解析结果（判别联合）。 */
export type PreviewParse = { readonly ok: true; readonly target: PreviewTarget } | { readonly ok: false; readonly reason: PreviewFailure };

/** 回环主机名集合（与 `ServerAuthGuard.LOOPBACK_HOSTS` 同一口径，但前端只认这几种写法）。 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/** 「主机:端口」无协议写法（`localhost:5173` / `example.com:8080` / `[::1]:5173`）。 */
const BARE_HOST_PORT = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+):(\d{1,5})(?=[/?#]|$)/i;

/** 带协议头的写法（用于区分 `file:` / `javascript:` 等非法协议）。 */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** 预览地址的判定器。 */
export class PreviewUrl {
  /**
   * 是否回环主机（去方括号后比较）。
   * @param host 主机名（可带 `[]`）
   * @returns 回环时为 true
   */
  public static isLoopbackHost(host: string): boolean {
    return LOOPBACK_HOSTS.has(host.trim().toLowerCase().replace(/^\[|\]$/g, ''));
  }

  /**
   * 该 URL 是否是回环 http(s) 地址（决定「在右栏打开」入口是否出现）。
   * @param raw URL 文本
   * @returns 合法且主机为回环时为 true
   */
  public static isLoopbackUrl(raw: string): boolean {
    try {
      const url = new URL(raw);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        PreviewUrl.isLoopbackHost(url.hostname)
      );
    } catch {
      return false;
    }
  }

  /**
   * 预览源应使用的主机名：**永远与 UI 主机名不同**（cookie 隔离，见文件头注释）。
   * @param appHost UI 主机名
   * @returns `localhost` / `127.0.0.1`；UI 不在回环时返回空串（本地预览不可用）
   */
  public static previewHostOf(appHost: string): string {
    const host = appHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost') return '127.0.0.1';
    return PreviewUrl.isLoopbackHost(host) ? 'localhost' : '';
  }

  /**
   * 把「带协议 / 带主机端口」的输入归一成绝对 URL；不像网址时返回 null。
   *
   * 只放行 http(s)：`file:` 能读本机文件、`javascript:` / `data:` 能绕过预览源，
   * 都不该出现在这个输入框的语义里。
   * @param raw 用户输入
   * @returns 规范化 URL；不是绝对网址时 null
   */
  public static absolute(raw: string): string | null {
    const text = raw.trim();
    if (text === '') return null;
    let candidate = text;
    const bare = BARE_HOST_PORT.exec(text);
    if (bare !== null) {
      // 先认「主机:端口」：`localhost:5173` 会被 SCHEME 误判成 `localhost:` 协议。
      candidate = `http://${text}`;
    } else if (PreviewUrl.isLoopbackHost(text)) {
      // 只写 `localhost` / `127.0.0.1` 时补默认端口（80）。
      candidate = `http://${text}/`;
    } else if (!SCHEME.test(text)) {
      return null;
    }
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname === '') return null;
    return url.toString();
  }

  /**
   * 解析一次地址输入。
   * @param raw 地址栏文本（绝对网址或工作区相对路径）
   * @param ctx UI 主机名与预览源端口
   * @returns 成功目标或失败原因
   */
  public static parse(raw: string, ctx: PreviewContext): PreviewParse {
    const text = raw.trim();
    if (text === '') return { ok: false, reason: 'empty' };
    const absolute = PreviewUrl.absolute(text);
    if (absolute !== null) {
      let url: URL;
      try {
        url = new URL(absolute);
      } catch {
        return { ok: false, reason: 'invalid' };
      }
      return {
        ok: true,
        target: { url: absolute, title: url.host || absolute, kind: 'remote' },
      };
    }
    // 盘符路径先归「越界」：它在语义上是本机绝对路径，给的文件路径文案才是可行动的；
    // 若先走协议判定会被当成未知 scheme（`C:`），用户只会看到"格式无法识别"。
    if (/^[A-Za-z]:[\\/]/.test(text)) return { ok: false, reason: 'outside' };
    // 形如 `file:` / `data:` 的写法在这里已经确定不是 http(s)，直接拒绝（别再当相对路径）。
    if (SCHEME.test(text)) return { ok: false, reason: 'invalid' };
    return PreviewUrl.local(text, ctx);
  }

  /**
   * 工作区相对路径 → 预览源 URL。
   * @param text 已确认不是绝对网址的输入
   * @param ctx UI 主机名与预览源端口
   * @returns 成功目标或失败原因
   */
  private static local(text: string, ctx: PreviewContext): PreviewParse {
    const previewHost = PreviewUrl.previewHostOf(ctx.appHost);
    if (previewHost === '') return { ok: false, reason: 'no-host' };
    if (ctx.previewPort === null || ctx.previewPort <= 0) return { ok: false, reason: 'no-preview' };
    // 查询串 / 片段原样保留（SPA 和带参数的静态页都需要），只对路径段做编码。
    const match = /^([^?#]*)([?#][\s\S]*)?$/.exec(text);
    const pathPart = match?.[1] ?? text;
    const suffix = match?.[2] ?? '';
    if (
      pathPart.startsWith('/') ||
      pathPart.startsWith('\\') ||
      pathPart.startsWith('~') ||
      /^[A-Za-z]:/.test(pathPart)
    ) {
      return { ok: false, reason: 'outside' };
    }
    const parts = pathPart
      .split(/[\\/]+/)
      .filter((p) => p !== '' && p !== '.');
    if (parts.includes('..')) return { ok: false, reason: 'outside' };
    const encoded = parts.map((p) => encodeURIComponent(p)).join('/');
    const base = `http://${previewHost}:${String(ctx.previewPort)}/`;
    return {
      ok: true,
      target: {
        url: encoded === '' ? base + suffix : base + encoded + suffix,
        title: parts.length === 0 ? 'index.html' : (parts[parts.length - 1] ?? 'index.html'),
        kind: 'local',
      },
    };
  }
}
