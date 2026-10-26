/** 设置 → 桌面：托盘/开机启动/更新/诊断（仅桌面桥可用；浏览器下展示说明）。 */
import * as React from 'react';
import {
  desktopBridge,
  type DesktopInfo,
  type DesktopUpdateStatus,
} from '../../../core/desktop/DesktopBridge.ts';
import { t } from '../../i18n/i18n.ts';

/** 更新状态的可读文案。 */
function statusText(status: DesktopUpdateStatus | null): string {
  if (status === null) return t('读取中…');
  switch (status.state) {
    case 'idle':
      return t('当前已是最新版本');
    case 'checking':
      return t('正在检查更新…');
    case 'available':
      return t('发现新版本 {version}', { version: status.version });
    case 'downloading':
      return t('正在下载… {percent}%', { percent: status.percent });
    case 'downloaded':
      return t('新版本 {version} 已下载，可安装', { version: status.version });
    case 'error':
      return t('更新失败：{message}', { message: status.message });
    case 'disabled':
      return t('当前构建未启用自动更新');
  }
}

/** 桌面设置栏。 */
export function DesktopSettingsSection(): React.ReactElement {
  const bridge = React.useMemo(() => desktopBridge(), []);
  const [info, setInfo] = React.useState<DesktopInfo | null>(null);
  const [update, setUpdate] = React.useState<DesktopUpdateStatus | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (bridge === null) return;
    let alive = true;
    void Promise.all([bridge.getInfo(), bridge.getUpdateStatus()])
      .then(([nextInfo, nextStatus]) => {
        if (!alive) return;
        setInfo(nextInfo);
        setUpdate(nextStatus);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    const unsubscribe = bridge.onUpdateStatus((status) => {
      if (alive) setUpdate(status);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bridge]);

  if (bridge === null) {
    return (
      <div className="sp-sec">
        <h3 className="sp-sec-title">{t('桌面')}</h3>
        <p className="sp-hint">{t('当前是浏览器模式；托盘、开机启动与自动更新只在安装版中可用。')}</p>
      </div>
    );
  }

  /**
   * 执行一个异步动作（统一 busy/error）。
   * @param key 动作标识。
   * @param action 动作。
   * @returns 无返回值。
   */
  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (key: 'closeToTray' | 'openAtLogin', enabled: boolean): void => {
    void run(key, async () => {
      if (key === 'closeToTray') await bridge.setCloseToTray(enabled);
      else await bridge.setOpenAtLogin(enabled);
      setInfo((previous) => (previous === null ? previous : { ...previous, [key]: enabled }));
    });
  };

  return (
    <>
      <div className="sp-sec">
        <h3 className="sp-sec-title">{t('桌面')}</h3>
        <div className="sp-kv">
          <span className="sp-k">{t('版本')}</span>
          <span className="sp-v">{info?.appVersion ?? '—'}</span>
        </div>
        <div className="sp-kv">
          <span className="sp-k">{t('平台')}</span>
          <span className="sp-v">{info?.platform ?? '—'}</span>
        </div>
        <div className="sp-kv">
          <span className="sp-k">{t('语言')}</span>
          <span className="sp-v">{info?.language ?? '—'}</span>
        </div>
        <div className="sp-kv">
          <span className="sp-k">{t('当前工作区')}</span>
          <span className="sp-v sp-v-path" title={info?.workspace ?? ''}>
            {info?.workspace ?? '—'}
          </span>
        </div>
      </div>

      <div className="sp-sec">
        <h3 className="sp-sec-title">{t('窗口与启动')}</h3>
        <div className="sp-field">
          <span className="sp-field-label">{t('关闭时最小化到托盘')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={info?.closeToTray === true ? 'true' : 'false'}
            className={'sp-seg-item' + (info?.closeToTray === true ? ' on' : '')}
            disabled={busy !== null}
            onClick={() => toggle('closeToTray', !(info?.closeToTray === true))}
          >
            {info?.closeToTray === true ? t('已开启') : t('已关闭')}
          </button>
          <span className="sp-hint">{t('长任务在后台继续运行；托盘菜单可随时恢复窗口。')}</span>
        </div>
        <div className="sp-field">
          <span className="sp-field-label">{t('开机启动')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={info?.openAtLogin === true ? 'true' : 'false'}
            className={'sp-seg-item' + (info?.openAtLogin === true ? ' on' : '')}
            disabled={busy !== null}
            onClick={() => toggle('openAtLogin', !(info?.openAtLogin === true))}
          >
            {info?.openAtLogin === true ? t('已开启') : t('已关闭')}
          </button>
          <span className="sp-hint">{t('登录系统后以托盘方式启动（Windows/macOS）。')}</span>
        </div>
      </div>

      <div className="sp-sec">
        <h3 className="sp-sec-title">{t('更新')}</h3>
        <p className="sp-hint" role="status" aria-live="polite">
          {statusText(update)}
        </p>
        <div className="sp-field">
          <button
            className="ghost"
            type="button"
            disabled={busy !== null}
            onClick={() => void run('check', () => bridge.checkForUpdates())}
          >
            {t('检查更新')}
          </button>
          {update?.state === 'available' ? (
            <button
              className="ghost"
              type="button"
              disabled={busy !== null}
              onClick={() => void run('download', () => bridge.downloadUpdate())}
            >
              {t('下载更新')}
            </button>
          ) : null}
          {update?.state === 'downloaded' ? (
            <button
              className="ghost"
              type="button"
              disabled={busy !== null}
              onClick={() => void run('install', () => bridge.installUpdate())}
            >
              {t('安装并重启')}
            </button>
          ) : null}
        </div>
      </div>

      <div className="sp-sec">
        <h3 className="sp-sec-title">{t('诊断')}</h3>
        <div className="sp-field">
          <button className="ghost" type="button" onClick={() => void bridge.openLogs()}>
            {t('打开日志目录')}
          </button>
          {bridge.showDiagnostics !== undefined ? (
            <button
              className="ghost"
              type="button"
              onClick={() => void bridge.showDiagnostics?.()}
            >
              {t('查看诊断信息')}
            </button>
          ) : null}
          <button
            className="ghost"
            type="button"
            disabled={busy !== null}
            onClick={() => void run('restart', () => bridge.restartHarness())}
          >
            {t('重启 Harness')}
          </button>
        </div>
      </div>

      {error !== '' ? (
        <p className="sp-hint sp-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
