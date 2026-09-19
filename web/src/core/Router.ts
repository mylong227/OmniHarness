// 前端哈希路由（F8）：把「当前右栏面板 + 当前会话」编码进 location.hash，
// 支持深链（刷新 / 分享链接直达）与浏览器前进 / 后退。纯函数 + 轻量订阅，不依赖 React。
// 浏览器不可用（单测）时回落到注入的全局 location / window，避免硬崩溃。

/** 一条路由：右侧激活面板标识 + 当前打开的会话 id（null 表示无）。 */
export interface AppRoute {
  /** 右栏面板标识（tools/changes/settings/...）。 */
  pane: string;
  /** 当前打开的会话 id；null 表示未打开具体会话。 */
  threadId: string | null;
}

/** 合法面板标识（与 NavRail / RightPanel 的 TABS 单一来源保持一致）。 */
const VALID_PANES: ReadonlySet<string> = new Set([
  'tools',
  'metrics',
  'changes',
  'settings',
  'plugins',
  'graph',
  'memory',
  'profiles',
  'file',
  'detail',
  'rollback',
]);

/** 默认路由（首屏 / 无 hash 时）。 */
const DEFAULT_ROUTE: Readonly<AppRoute> = { pane: 'tools', threadId: null };

/**
 * 读取当前 location.hash（浏览器不可用时回落空串）。
 * @returns 原始 hash 串（含前导 #）
 */
function currentHash(): string {
  try {
    return typeof location !== 'undefined' && typeof location.hash === 'string' ? location.hash : '';
  } catch {
    return '';
  }
}

/**
 * 把原始 hash 解析为路由；非法面板标识回落默认。
 * @returns 解析后的路由
 */
export function parseHash(): AppRoute {
  const h = currentHash().replace(/^#/, '');
  if (h === '') return { pane: DEFAULT_ROUTE.pane, threadId: null };
  const params = new URLSearchParams(h);
  const paneRaw = params.get('pane');
  const pane = paneRaw !== null && VALID_PANES.has(paneRaw) ? paneRaw : DEFAULT_ROUTE.pane;
  const threadRaw = params.get('thread');
  return { pane, threadId: threadRaw === null || threadRaw === '' ? null : threadRaw };
}

/**
 * 把路由序列化为 hash 串（含前导 #）。
 * @param route 路由
 * @returns hash 串
 */
export function toHash(route: AppRoute): string {
  const params = new URLSearchParams();
  params.set('pane', route.pane);
  if (route.threadId !== null && route.threadId !== '') params.set('thread', route.threadId);
  return '#' + params.toString();
}

/**
 * 导航到指定路由：写入 location.hash（触发 hashchange，由订阅者统一收口状态）。
 * 写入相同 hash 时浏览器不触发 hashchange，天然幂等、不会死循环。
 * @param route 目标路由
 * @returns 无
 */
export function navigate(route: AppRoute): void {
  try {
    if (typeof location !== 'undefined') location.hash = toHash(route);
  } catch {
    /* 忽略：非浏览器环境无 location */
  }
}

/**
 * 订阅 hashchange；回调收到解析后的路由。返回取消订阅函数。
 * @param cb 路由变化回调
 * @returns 取消订阅函数（无 window 时为空操作）
 */
export function onRouteChange(cb: (route: AppRoute) => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const handler = (): void => {
    cb(parseHash());
  };
  window.addEventListener('hashchange', handler);
  return () => {
    if (typeof window.removeEventListener === 'function') window.removeEventListener('hashchange', handler);
  };
}

/**
 * 判断面板标识是否合法（供调用方校验，避免把脏值写进 hash）。
 * @param pane 面板标识
 * @returns 是否合法
 */
export function isValidPane(pane: string): boolean {
  return VALID_PANES.has(pane);
}
