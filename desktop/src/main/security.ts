/** 渲染层加固：导航/窗口打开/权限/CSP。 */
import { app, shell, type Session, type WebContents } from 'electron';
import { formatCsp, type DesktopSecurityConfig } from './config.ts';

/** 允许的 harness origin（每次启动/切换工作区更新）。 */
let harnessOrigin = '';

/**
 * 把 host/port 拼成 origin（IPv6 加方括号）。
 * @param host 主机。
 * @param port 端口。
 * @returns origin 字符串。
 */
const originOf = (host: string, port: number): string =>
  `http://${host.includes(':') ? `[${host}]` : host}:${String(port)}`;

/**
 * 设置当前 harness origin。
 * @param port 实际端口。
 * @param host Harness 主机（缺省 127.0.0.1）。
 * @returns 无返回值。
 */
export function setHarnessOrigin(port: number, host = '127.0.0.1'): void {
  harnessOrigin = originOf(host, port);
}

/**
 * 当前 harness origin。
 * @returns origin 字符串。
 */
export function currentHarnessOrigin(): string {
  return harnessOrigin;
}

/**
 * 给指定 session 注入 CSP 与权限白名单。
 * @param session Electron session。
 * @param port 实际端口。
 * @param config 安全配置（host/CSP/允许的权限）。
 * @returns 无返回值。
 */
export function installSessionSecurity(
  session: Session,
  port: number,
  config: DesktopSecurityConfig & { readonly host: string },
): void {
  const origin = originOf(config.host, port);
  const allowedPermissions = new Set(config.permissions);
  session.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
    const headers = { ...(details.responseHeaders ?? {}) };
    headers['Content-Security-Policy'] = [formatCsp(config.csp)];
    callback({ responseHeaders: headers });
  });
  session.setPermissionRequestHandler((contents, permission, callback) => {
    const url = contents.getURL();
    const trusted = url.startsWith(`${origin}/`) || url === origin;
    callback(trusted && allowedPermissions.has(permission));
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return requestingOrigin === origin && allowedPermissions.has(permission);
  });
}

/**
 * 给一个 WebContents 挂导航/窗口打开守卫。
 * @param contents WebContents。
 * @returns 无返回值。
 */
export function guardContents(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    // 只放行 Harness origin 与安装包内的 loading.html（`loadFile` 的程序化导航
    // 通常不触发 will-navigate，但不同 Electron 版本/平台有差异，这里显式兜底）。
    const isInternalLoading = url.startsWith('file://') && url.endsWith('/loading.html');
    if (!isHarnessUrl(url) && !isInternalLoading) {
      event.preventDefault();
      void openExternalSafely(url);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/**
 * 给 app 内所有新 WebContents 挂守卫（只挂一次）。
 * @returns 无返回值。
 */
export function installGlobalGuards(): void {
  app.on('web-contents-created', (_event, contents) => guardContents(contents));
}

/**
 * 当前 URL 是否属于 harness origin。
 * @param url URL。
 * @returns 是则 true。
 */
export function isHarnessUrl(url: string): boolean {
  if (harnessOrigin === '') return false;
  try {
    return new URL(url).origin === harnessOrigin;
  } catch {
    return false;
  }
}

/**
 * 只允许 http(s)/mailto 走系统浏览器；file/smb/javascript/data 一律拒绝。
 * @param url 目标 URL。
 * @returns 无返回值。
 */
export async function openExternalSafely(url: string): Promise<void> {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return;
  }
  if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'mailto:') return;
  await shell.openExternal(url).catch(() => undefined);
}
