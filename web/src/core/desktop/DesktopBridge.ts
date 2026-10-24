/**
 * 桌面宿主桥（浏览器下为 null）。
 *
 * 只做能力检测与轻量封装：UI 不直接读 `window.omni`，也不依赖 Electron。
 * 桌面端 preload 暴露的是最小面；浏览器/测试环境没有 `window.omni` 时全部 no-op。
 */

/** 通知输入（与 desktop preload 对齐）。 */
export interface DesktopNotifyInput {
  /** 标题。 */
  readonly title: string;
  /** 正文。 */
  readonly body: string;
  /** 关联会话 id。 */
  readonly sessionId?: string;
}

/** 桌面桥最小面（只声明 UI 用到的部分）。 */
export interface DesktopBridge {
  /** 桥版本。 */
  readonly apiVersion: number;
  /** 原生通知。 */
  notify(input: DesktopNotifyInput): Promise<unknown>;
  /** 点击通知后回传 sessionId；返回取消订阅函数。 */
  onNotificationClick(listener: (sessionId: string | undefined) => void): () => void;
  /** 深链（`omniharness://open?...`）；返回取消订阅函数。 */
  onDeepLink(listener: (url: string) => void): () => void;
}

/** 读取全局桥；结构不合法时返回 null（fail-safe）。 */
export function desktopBridge(): DesktopBridge | null {
  const candidate = (globalThis as { omni?: unknown }).omni;
  if (candidate === null || typeof candidate !== 'object') return null;
  const raw = candidate as Record<string, unknown>;
  if (
    raw['apiVersion'] !== 1 ||
    typeof raw['notify'] !== 'function' ||
    typeof raw['onNotificationClick'] !== 'function' ||
    typeof raw['onDeepLink'] !== 'function'
  ) {
    return null;
  }
  return {
    apiVersion: 1,
    notify: (input) => (raw['notify'] as (value: DesktopNotifyInput) => Promise<unknown>)(input),
    onNotificationClick: (listener) =>
      (
        raw['onNotificationClick'] as (
          value: (sessionId: string | undefined) => void,
        ) => () => void
      )(listener),
    onDeepLink: (listener) =>
      (raw['onDeepLink'] as (value: (url: string) => void) => () => void)(listener),
  };
}

/**
 * 发桌面通知；无桌面桥时静默。
 * @param input 通知内容。
 * @returns 无返回值（fire-and-forget）。
 */
export function notifyDesktop(input: DesktopNotifyInput): void {
  const bridge = desktopBridge();
  if (bridge === null) return;
  void bridge.notify(input).catch(() => undefined);
}
