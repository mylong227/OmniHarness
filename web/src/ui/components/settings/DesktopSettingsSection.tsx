/** 控制台 → 桌面：托盘 / 开机启动 / 更新 / 诊断（仅桌面桥可用；浏览器下说明边界）。 */
import * as React from 'react';
import {
  desktopBridge,
  type DesktopInfo,
  type DesktopUpdateStatus,
} from '../../../core/desktop/DesktopBridge.ts';
import { t } from '../../i18n/i18n.ts';
import { ConsoleCard, ConsoleInfoRow, ConsoleRow, ConsoleSwitch } from '../console/ConsoleUI.tsx';

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

/**
 * 桌面设置页。
 * @returns 页面节点
 */
/** 桌面桥类型（非空）。 */
type DesktopBridge = NonNullable<ReturnType<typeof desktopBridge>>;

/**
 * 应用信息卡。
 * @param props 只读信息。
 * @returns 卡片节点。
 */
function DesktopInfoCard(props: { info: DesktopInfo | null }): React.ReactElement {
  return (
    <ConsoleCard title={t('应用信息')} description={t('来自桌面桥的只读信息。')}>
      <ConsoleInfoRow label={t('版本')} value={props.info?.appVersion ?? '—'} />
      <ConsoleInfoRow label={t('平台')} value={props.info?.platform ?? '—'} />
      <ConsoleInfoRow label={t('语言')} value={props.info?.language ?? '—'} />
      <ConsoleInfoRow
        label={t('当前工作区')}
        value={props.info?.workspace ?? '—'}
        title={props.info?.workspace ?? ''}
      />
    </ConsoleCard>
  );
}

/**
 * 窗口与启动卡。
 * @param props 信息、忙碌态与切换回调。
 * @returns 卡片节点。
 */
function DesktopWindowCard(props: {
  info: DesktopInfo | null;
  busy: string | null;
  onToggle: (key: 'closeToTray' | 'openAtLogin', enabled: boolean) => void;
}): React.ReactElement {
  return (
    <ConsoleCard
      title={t('窗口与启动')}
      description={t('长任务在后台继续运行；托盘菜单可随时恢复窗口。')}
    >
      <ConsoleRow label={t('关闭时最小化到托盘')} hint={t('关闭窗口不结束会话与任务。')}>
        <span className="csl-switch-state">
          {props.info?.closeToTray === true ? t('已开启') : t('已关闭')}
        </span>
        <ConsoleSwitch
          label={t('关闭时最小化到托盘')}
          checked={props.info?.closeToTray === true}
          disabled={props.busy !== null}
          onChange={(checked) => props.onToggle('closeToTray', checked)}
        />
      </ConsoleRow>
      <ConsoleRow label={t('开机启动')} hint={t('登录系统后以托盘方式启动（Windows / macOS）。')}>
        <span className="csl-switch-state">
          {props.info?.openAtLogin === true ? t('已开启') : t('已关闭')}
        </span>
        <ConsoleSwitch
          label={t('开机启动')}
          checked={props.info?.openAtLogin === true}
          disabled={props.busy !== null}
          onChange={(checked) => props.onToggle('openAtLogin', checked)}
        />
      </ConsoleRow>
    </ConsoleCard>
  );
}

/**
 * 更新卡。
 * @param props 更新状态、桥与动作执行器。
 * @returns 卡片节点。
 */
function DesktopUpdateCard(props: {
  update: DesktopUpdateStatus | null;
  busy: string | null;
  bridge: DesktopBridge;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
}): React.ReactElement {
  return (
    <ConsoleCard
      title={t('更新')}
      description={statusText(props.update)}
      actions={
        <>
          <button
            className="csl-btn"
            type="button"
            disabled={props.busy !== null}
            onClick={() => void props.run('check', () => props.bridge.checkForUpdates())}
          >
            {t('检查更新')}
          </button>
          {props.update?.state === 'available' ? (
            <button
              className="csl-btn"
              type="button"
              disabled={props.busy !== null}
              onClick={() => void props.run('download', () => props.bridge.downloadUpdate())}
            >
              {t('下载更新')}
            </button>
          ) : null}
          {props.update?.state === 'downloaded' ? (
            <button
              className="csl-btn csl-btn--primary"
              type="button"
              disabled={props.busy !== null}
              onClick={() => void props.run('install', () => props.bridge.installUpdate())}
            >
              {t('安装并重启')}
            </button>
          ) : null}
        </>
      }
    >
      <p className="csl-note" role="status" aria-live="polite">
        {t('更新由桌面应用的后台服务完成；下载完成后可在此安装并重启。')}
      </p>
    </ConsoleCard>
  );
}

/**
 * 诊断卡。
 * @param props 桥、忙碌态与动作执行器。
 * @returns 卡片节点。
 */
function DesktopDiagnosticsCard(props: {
  busy: string | null;
  bridge: DesktopBridge;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
}): React.ReactElement {
  return (
    <ConsoleCard title={t('诊断')} description={t('日志目录与运行时排障入口。')}>
      <ConsoleRow label={t('日志')}>
        <button className="csl-btn" type="button" onClick={() => void props.bridge.openLogs()}>
          {t('打开日志目录')}
        </button>
      </ConsoleRow>
      {props.bridge.showDiagnostics === undefined ? null : (
        <ConsoleRow label={t('诊断信息')}>
          <button className="csl-btn" type="button" onClick={() => void props.bridge.showDiagnostics?.()}>
            {t('查看诊断信息')}
          </button>
        </ConsoleRow>
      )}
      <ConsoleRow label={t('重启 Harness')} hint={t('只重启后台服务，不关闭窗口。')}>
        <button
          className="csl-btn"
          type="button"
          disabled={props.busy !== null}
          onClick={() => void props.run('restart', () => props.bridge.restartHarness())}
        >
          {t('重启 Harness')}
        </button>
      </ConsoleRow>
    </ConsoleCard>
  );
}

/**
 * 桌面设置区（安装版可用）。
 * @returns 设置区节点。
 */
export function DesktopSettingsSection(): React.ReactElement {
  const bridge = React.useMemo(() => desktopBridge(), []);
  const [info, setInfo] = React.useState<DesktopInfo | null>(null);
  const [update, setUpdate] = React.useState<DesktopUpdateStatus | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (bridge === null) return undefined;
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
      <ConsoleCard
        title={t('桌面')}
        description={t('当前是浏览器模式；托盘、开机启动与自动更新只在安装版中可用。')}
      >
        <p className="csl-empty">{t('在安装版中打开，可在这里管理窗口行为与更新。')}</p>
      </ConsoleCard>
    );
  }

  /**
   * 执行一个异步动作（统一 busy/error）。
   * @param key 动作标识
   * @param action 动作
   * @returns 无
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
      {error === '' ? null : (
        <div className="sp-load-error csl-banner" role="alert">
          <span>{error}</span>
        </div>
      )}

      <DesktopInfoCard info={info} />
      <DesktopWindowCard info={info} busy={busy} onToggle={toggle} />
      <DesktopUpdateCard update={update} busy={busy} bridge={bridge} run={run} />
      <DesktopDiagnosticsCard busy={busy} bridge={bridge} run={run} />
    </>
  );
}
