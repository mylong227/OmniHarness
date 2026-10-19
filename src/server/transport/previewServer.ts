// 工作区**网页预览**源（2026-10-19）：把工作区里的静态站点（HTML / CSS / JS / 字体 / 图片）
// 原样以只读方式提供给右栏的 `<iframe>`。
//
// ## 为什么不复用主服务的 GET /files（那是**另一个语义**）
//
// `/files` 是为下载设计的：`Content-Disposition: attachment` 会让浏览器**下载**而不是渲染；
// 它的路径映射也只覆盖单文件，页面里的相对资源（`./app.js`、`/assets/x.css`）无法解析。
// 预览需要的是「一个能解析相对路径的静态站点根」。
//
// ## 为什么静态服务交给 sirv（成熟依赖，而不是手搓）
//
// MIME 判定、目录/扩展名回落、Range/HEAD、缓存头这一整套协议细节，手写等价物就是**长期自维护的
// 服务器**（本文件首版 260 行、还踩了「目录被读成 0 字节」的 Windows 坑）。按
// `docs/DEPENDENCY_POLICY.md` 的 D10（必要且更优即用成熟依赖），这里用 `sirv`（MIT，依赖树
// 3 个包、Vite/Polka 生态广泛使用）承担静态响应；本仓只保留两件**业务边界**：
//   ① 工作区安全：路径解析仍走 `SafeFs.safeStat`（词法 + realpath，拦 symlink/junction 逃逸，
//      并拒绝点文件）；sirv 只负责发送已经过守卫的**具体文件**；
//   ② 预览语义：HTML 统一补 UTF-8 charset（sirv 的 mrmime 不写 charset，中文页会花）。
//
// ## 为什么单独一个回环端口（而**不是**主服务同源下的 /preview 前缀）
//
// 安全边界（本特性的核心取舍）：
//   · 主服务带 HttpOnly 会话 cookie，且 `/rpc` 能驱动 agent 执行任意工具；
//   · 同源 iframe 里的页面**能带着会话调用 /rpc**（同源不存在 CORS 阻挡）——工作区里的 HTML
//     可能是 Agent 从外部页面抄来的，预览它就等于给它一次本机 RCE 机会；
//   · 独立端口是**跨源**：`fetch('/rpc')` 走 CORS 预检（主服务不答 CORS ⇒ 被拦），
//     且前端把 iframe 地址写成与 UI **不同的回环主机名**（`localhost` ↔ `127.0.0.1`），
//     会话 cookie 是 host-only（且 `SameSite=Strict`），所以请求根本带不上它。
//     两层叠加后，预览页拿不到 UI 的会话。
//
// ## 只读且 fail-closed
//
// · 只接受 GET / HEAD；
// · 路径经 `SafeFs.safeStat`（与 `/files`、`fs.read` 同一套越界 + symlink/junction 判定），
//   越界 403、缺失 404，绝不把工作区外的文件读出来；点文件默认拒绝（`.well-known` 除外）；
// · 不提供目录列表（sirv 只回 `index.html` / `index.htm` 或扩展名回落，不做 listing）。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import sirv, { type RequestHandler } from 'sirv';
import { SafeFs } from '../services/safeFs.ts';

/** 预览源选项。 */
export interface PreviewServerOptions {
  /** 工作区根（方法注入：切换工作区后无需重启预览源）。 */
  readonly workspaceRoot: () => string;
  /** 绑定地址（缺省回环 IPv4）。 */
  readonly host?: string | undefined;
}

/** 单文件上限（字节）：与 SafeFs 的硬上限一致（大产物不会把内存读爆）。 */
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;

/** sirv 的扩展名回落（`/login` → `login.html` / `login.htm`；目录同样回落到 index）。 */
const EXTENSIONS: readonly string[] = ['html', 'htm'];

/** 路径解析结果：命中一个已通过守卫的文件 / 越界 / 不存在。 */
type ResolvedPath =
  { readonly kind: 'file'; readonly relative: string } | { readonly kind: 'forbidden' } | null;

/** 工作区静态预览服务：只读、只回环、sirv 发送 + SafeFs 路径守卫。 */
export class PreviewServer {
  /** 默认绑定地址（只绑回环：预览源绝不出网）。 */
  public static readonly DEFAULT_HOST = '127.0.0.1';

  /** node:http 实例（start 前为 null）。 */
  private server: Server | null = null;
  /** 实际监听端口（0 = 未启动）。 */
  private boundPort = 0;
  /** 选项（工作区根 + 绑定地址）。 */
  private readonly options: PreviewServerOptions;
  /** sirv 处理器缓存：根目录变化（切换工作区）时重建。 */
  private handler: RequestHandler | null = null;
  /** 当前 handler 对应的根。 */
  private handlerRoot = '';

  /**
   * @param options 工作区根提供者与绑定地址
   */
  public constructor(options: PreviewServerOptions) {
    this.options = options;
  }

  /**
   * 当前监听端口。
   * @returns 端口；未启动为 0
   */
  public get port(): number {
    return this.boundPort;
  }

  /**
   * 启动监听。
   * @param port 期望端口（0 = 由系统分配）
   * @returns 实际监听端口
   */
  public async start(port = 0): Promise<number> {
    const server = createServer((request, response) => {
      // 路由是异步的：失败必须收敛成一次可读响应，不能让 rejection 变成 unhandledRejection。
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        if (!response.writableEnded) response.end('预览服务内部错误');
      });
    });
    // 连接级防护：预览是静态小文件，不需要长连接与慢速头。
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    server.maxConnections = 64;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(port, this.options.host ?? PreviewServer.DEFAULT_HOST, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
    const address = server.address();
    this.server = server;
    this.boundPort = typeof address === 'object' && address !== null ? address.port : port;
    return this.boundPort;
  }

  /**
   * 关闭监听并强制断开连接（未启动时为空操作）。
   * @returns 关闭完成后 resolve
   */
  public async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  /**
   * 处理一条请求：只放行 GET / HEAD，先过工作区守卫，再交给 sirv 发送。
   * @param request 原始请求
   * @param response 响应对象
   * @returns 响应写出后 resolve
   */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Method Not Allowed');
      return;
    }
    const workspaceRoot = this.options.workspaceRoot();
    if (workspaceRoot === '') {
      response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('工作区未配置');
      return;
    }
    const relative = PreviewServer.relativeOf(request.url ?? '/');
    if (relative === null) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('预览路径无法解析');
      return;
    }
    const resolved = PreviewServer.resolve(workspaceRoot, relative);
    if (resolved === null) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`Not Found：工作区中没有 ${relative}`);
      return;
    }
    if (resolved.kind === 'forbidden') {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Forbidden');
      return;
    }
    const stat = SafeFs.safeStat(workspaceRoot, resolved.relative);
    if (stat.ok && stat.size > MAX_PREVIEW_BYTES) {
      response.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('文件过大，拒绝整文件读入内存');
      return;
    }
    // sirv 只收到「已通过守卫的具体文件」：改写 url 后让它负责 MIME / Range / HEAD / 缓存头。
    const target = Object.create(request) as IncomingMessage;
    target.url = '/' + resolved.relative.split('/').map(encodeURIComponent).join('/');
    // 中文页面必须声明 UTF-8：sirv 的 mrmime 只给 `text/html`（浏览器会按系统编码猜）。
    const wrapped = PreviewServer.withUtf8Charset(response);
    this.handlerFor(workspaceRoot)(target, wrapped, () => {
      if (!wrapped.headersSent) {
        wrapped.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      if (!wrapped.writableEnded) wrapped.end('Not Found');
    });
  }

  /**
   * 取（或重建）当前工作区根对应的 sirv 处理器。
   * @param root 工作区根
   * @returns sirv 中间件
   */
  private handlerFor(root: string): RequestHandler {
    if (this.handler === null || this.handlerRoot !== root) {
      this.handler = sirv(root, {
        // dev：每次请求都查文件系统（改完刷新即可看到），且不写生产缓存头。
        dev: true,
        etag: false,
        extensions: [...EXTENSIONS],
        dotfiles: false,
        setHeaders: (res: ServerResponse) => {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        },
      });
      this.handlerRoot = root;
    }
    return this.handler;
  }

  /**
   * 给响应补 UTF-8 charset（仅 text/* 与 JSON/XML，且原本没写 charset 时）。
   *
   * 为什么要在 `writeHead` 上做：sirv/send 把 `Content-Type` 直接放进 `writeHead` 的头对象，
   * `res.setHeader` 会被它覆盖；唯一可控的注入点就是 `writeHead` 本身。
   * @param response 原始响应
   * @returns 同一个响应对象（已包装）
   */
  private static withUtf8Charset(response: ServerResponse): ServerResponse {
    const original = response.writeHead.bind(response) as (...args: unknown[]) => ServerResponse;
    response.writeHead = ((...args: unknown[]): ServerResponse => {
      const headers = args[1];
      if (headers !== null && typeof headers === 'object' && !Array.isArray(headers)) {
        const record = headers as Record<string, unknown>;
        const key = Object.keys(record).find((name) => name.toLowerCase() === 'content-type');
        if (key !== undefined) {
          const type = String(record[key]);
          const textual =
            type.startsWith('text/') ||
            type === 'application/json' ||
            type === 'application/xml' ||
            type === 'application/manifest+json';
          if (textual && !/charset=/iu.test(type)) record[key] = `${type}; charset=utf-8`;
        }
      }
      return original(...args);
    }) as ServerResponse['writeHead'];
    return response;
  }

  /**
   * 把 URL 转成工作区相对路径（解码 + 反斜杠归一）。
   * @param url 原始请求 URL
   * @returns 相对路径；无法解码时 null
   */
  private static relativeOf(url: string): string | null {
    let pathname: string;
    try {
      pathname = new URL(url, 'http://preview.local').pathname;
    } catch {
      return null;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;
    // 浏览器按 UTF-8 发送；URL 分隔符统一成 `/`（Windows 上 `\` 也是分隔符）。
    // **不要**用 path.normalize：Windows 会把它改写成 `\` 并吃掉末尾 `/`，而末尾斜杠正是
    // 「目录请求，需要索引兜底」的信号（`SafeFs` 自己会 resolve 归一路径）。
    const raw = decoded.replace(/^\/+/, '').replace(/\\/g, '/');
    return raw.replace(/\/{2,}/g, '/');
  }

  /**
   * 按 sirv 的候选顺序解析出**一个已通过 SafeFs 守卫**的文件。
   *
   * 候选顺序与 sirv 的 `toAssume` 一致：`x` → `x/index` → `x.html` → `x/index.html` →
   * `x.htm` → `x/index.htm`（根路径只有后三者的 index）。每个候选都先过 `safeStat`
   * （词法越界 + realpath 双重判定），确保 symlink/junction 不能把工作区外的文件带进来。
   * @param root 工作区根
   * @param relative 已归一的相对路径
   * @returns 命中文件 / 越界 / 不存在
   */
  private static resolve(root: string, relative: string): ResolvedPath {
    const base = relative.replace(/\/+$/, '');
    if (PreviewServer.hasDotSegment(base)) return null;
    const candidates: string[] = [];
    for (const ext of ['', ...EXTENSIONS.map((e) => `.${e}`)]) {
      if (base !== '') candidates.push(base + ext);
      candidates.push(`${base === '' ? '' : base + '/'}index${ext}`);
    }
    for (const candidate of candidates) {
      const stat = SafeFs.safeStat(root, candidate);
      if (!stat.ok) {
        if (stat.error === '路径越界工作区') return { kind: 'forbidden' };
        continue;
      }
      if (stat.isFile) return { kind: 'file', relative: candidate };
    }
    return null;
  }

  /**
   * 是否含点文件段（`.well-known` 是规范允许的例外，sirv 默认也保留它）。
   * @param relative 相对路径
   * @returns 需要拒绝时为 true
   */
  private static hasDotSegment(relative: string): boolean {
    return (
      relative
        .split('/')
        // `..` 交给 SafeFs 判越界（它要回 403），这里只拦真正的点文件（`.env` / `.git`）。
        .some((segment) => segment !== '..' && segment.startsWith('.') && segment !== '.well-known')
    );
  }
}
