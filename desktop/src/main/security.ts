/** 渲染层加固：导航/窗口打开/权限/CSP。 */
import { app, shell, type Session, type WebContents } from 'electron';

/** 允许的 harness origin（每次启动/切换工作区更新）。 */
let harnessOrigin = '';

/**
 * 设置当前 harness origin。
 * @param port 实际端口。
 * @returns 无返回值。
 */
export function setHarnessOrigin(port: number): void {
  harnessOrigin = `http://127.0.0.1:${String(port)}`;
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
 * @returns 无返回值。
 */
export function installSessionSecurity(session: Session, port: number): void {
  const origin = `http://127.0.0.1:${String(port)}`;
  session.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
    const headers = { ...(details.responseHeaders ?? {}) };
    headers['Content-Security-Policy'] = [
      [
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
        'frame-src http://127.0.0.1:*',
        "media-src 'self' blob:",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    ];
    callback({ responseHeaders: headers });
  });
  session.setPermissionRequestHandler((contents, permission, callback) => {
    const url = contents.getURL();
    const trusted = url.startsWith(`${origin}/`) || url === origin;
    const allowed = permission === 'notifications' || permission === 'clipboard-sanitized-write';
    callback(trusted && allowed);
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    const allowed = permission === 'notifications' || permission === 'clipboard-sanitized-write';
    return requestingOrigin === origin && allowed;
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
