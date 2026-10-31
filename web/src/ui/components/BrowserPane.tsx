// 右栏「网页」面板（内置浏览器，2026-10-19）：地址栏 + 重载 / 外部打开 + `<iframe>`。
//
// 为什么用 iframe 而不是 WebView：本仓是标准 Web（Vite + React）应用，没有原生壳；
// iframe 是唯一在浏览器内既能渲染任意站点、又受同源策略约束的做法——**这个约束正是安全边界**：
// 预览页与工作台不同源（工作区预览还刻意换了回环主机名，见 models/PreviewUrl.ts），
// 所以它读不到工作台的 DOM / localStorage，也带不上会话 cookie。
//
// 跨源页面的 `history` / `reload` 都不可访问（读 `contentWindow.location` 会抛 SecurityError），
// 故「重载」用 **React key 重建 iframe**，而不是去调页面内 API。
//
// 已知边界（如实写在 UI 边注里，不假装万能）：部分站点用 `X-Frame-Options` / CSP
// `frame-ancestors` 拒绝嵌入，此时 iframe 会留白；「在新窗口打开」是退路。

import * as React from 'react';
import { icon } from '../models/Icon.ts';
import { hostOf } from '../textUtils.ts';
import type { BrowserView } from '../shared.ts';
import { t } from '../i18n/i18n.ts';

/** BrowserPane 组件的入参。 */
export interface BrowserPaneProps {
  /** 网页标签状态（地址 / 标题 / 重载代数 / 失败原因）。 */
  view: BrowserView;
  /** 会话里出现过的回环开发地址（空态里一键直达；空数组不渲染该区块）。 */
  recentUrls?: readonly string[];
  /** 地址栏提交（绝对网址或工作区相对路径）。 */
  onNavigate: (input: string) => void | Promise<void>;
  /** 重载当前页。 */
  onReload: () => void;
}

/**
 * 打开外部窗口（失败静默：弹窗被拦截时用户仍可复制地址）。
 * @param url 目标地址
 * @returns 无
 */
function openExternal(url: string): void {
  if (url === '') return;
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    // 弹窗被拦截：地址栏仍可复制，不当成错误。
  }
}

/**
 * 右栏网页面板：地址栏 + iframe（无地址时给空态引导）。
 * @param props 组件入参
 * @returns 网页面板节点
 */
/**
 * 地址栏工具条：重载 / 输入 / 打开 / 新窗口打开。
 * @param props 地址草稿、就绪态与各回调。
 * @returns 工具条节点。
 */
function AddressBar(props: {
  readonly address: string;
  readonly hasUrl: boolean;
  readonly onReload: () => void;
  readonly onAddressChange: (value: string) => void;
  readonly onAddressKey: (e: React.KeyboardEvent) => void;
  readonly onSubmit: () => void;
  readonly externalUrl: string;
}): ReactElement {
  return (
    <div className="web-bar">
      <button
        className="iconbtn web-reload"
        type="button"
        title={t('重新加载')}
        aria-label={t('重新加载')}
        disabled={!props.hasUrl}
        onClick={props.onReload}
      >
        {icon('refresh', { size: 15 })}
      </button>
      <input
        className="web-addr"
        type="text"
        value={props.address}
        spellCheck={false}
        autoComplete="off"
        aria-label={t('网页地址')}
        placeholder={t('输入网址或工作区路径，如 http://localhost:5173 或 index.html')}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.onAddressChange(e.target.value)}
        onKeyDown={props.onAddressKey}
      />
      <button className="btn web-go" type="button" onClick={props.onSubmit}>
        {t('打开')}
      </button>
      <button
        className="iconbtn web-external"
        type="button"
        title={t('在新窗口打开')}
        aria-label={t('在新窗口打开')}
        disabled={!props.hasUrl}
        onClick={() => openExternal(props.externalUrl)}
      >
        {icon('external-link', { size: 15 })}
      </button>
    </div>
  );
}

/**
 * 网页预览面板（地址栏 + iframe / 空态 + 错误条）。
 * @param props 组件属性。
 * @returns 面板节点。
 */
export function BrowserPane(props: BrowserPaneProps): ReactElement {
  const { view, recentUrls, onNavigate, onReload } = props;
  /** 地址栏草稿（与 view.url 解耦：用户编辑时不立刻改 iframe）。 */
  const [address, setAddress] = React.useState<string>(view.url);

  // 外部导航（点链接 / 预览文件）后，地址栏跟着当前页走；用户正在输入时也以新导航为准
  // ——这正是"点了就直接打开"的语义。
  React.useEffect(() => {
    setAddress(view.url);
  }, [view.url]);

  /**
   * 提交地址栏。
   * @returns 无
   */
  const submit = (): void => {
    const text = address.trim();
    if (text === '') return;
    void onNavigate(text);
  };

  /**
   * 地址栏键盘：Enter 打开，Esc 还原为当前页。
   * @param e 键盘事件
   * @returns 无
   */
  const onAddressKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setAddress(view.url);
    }
  };

  const hasUrl = view.url !== '';
  const recent = recentUrls ?? [];

  return (
    <div className="web-pane">
      <AddressBar
        address={address}
        hasUrl={hasUrl}
        onReload={onReload}
        onAddressChange={setAddress}
        onAddressKey={onAddressKey}
        onSubmit={submit}
        externalUrl={view.url}
      />
      {view.error === '' ? null : (
        <div className="web-error" role="alert">
          {icon('alert', { size: 14 })} {view.error}
        </div>
      )}
      {hasUrl ? (
        <iframe
          key={`${view.url}::${String(view.reloadKey)}`}
          className="web-frame"
          title={view.title === '' ? t('网页预览') : view.title}
          src={view.url}
          // 预览不做权限预授权：摄像头/麦克风/剪贴板等一律不主动给。
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : (
        <BrowserEmpty
          recent={recent}
          onNavigate={(url) => {
            setAddress(url);
            void onNavigate(url);
          }}
        />
      )}
    </div>
  );
}

/**
 * 空态（无 URL）：最近地址列表 + 首页预览入口 + iframe 限制说明。
 * @param props recent 最近地址；onNavigate 点选后导航（调用方同时回填地址栏）。
 * @returns 空态节点。
 */
function BrowserEmpty(props: {
  readonly recent: readonly string[];
  readonly onNavigate: (url: string) => void;
}): ReactElement {
  return (
    <div className="web-empty">
      <div className="web-empty-head">
        {icon('globe', { size: 22 })}
        <div>
          <div className="web-empty-title">{t('在右栏浏览网页')}</div>
          <div className="web-empty-hint">
            {t('输入网址或工作区里的 HTML 路径，回车即可预览；本地 dev server 启动后把地址粘进来即可。')}
          </div>
        </div>
      </div>
      {props.recent.length === 0 ? null : (
        <div className="web-recent">
          <div className="web-recent-title">{t('最近出现的本地地址')}</div>
          {props.recent.map((url) => (
            <button
              className="web-recent-item"
              type="button"
              key={url}
              title={url}
              onClick={() => props.onNavigate(url)}
            >
              <span className="web-recent-host">{hostOf(url)}</span>
              <span className="web-recent-url">{url}</span>
            </button>
          ))}
        </div>
      )}
      <div className="web-empty-actions">
        <button
          className="btn"
          type="button"
          onClick={() => props.onNavigate('index.html')}
        >
          {t('预览工作区首页')}
        </button>
      </div>
      <div className="web-note">
        {t('部分站点禁止被 iframe 嵌入（X-Frame-Options / CSP），页面空白时请用「在新窗口打开」。')}
      </div>
    </div>
  );
}
