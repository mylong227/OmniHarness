// 控制台里的「设置页」：常规 / 外观 / 模型与厂商 / 运行时 / 权限 / 桌面 / 键盘快捷键。
//
// 状态事实源仍是 `models/SettingsModel.ts`（零 React，可单测）；本文件只负责：
//   ① 生命周期（首次装载、卸载释放、厂商目录加载）；
//   ② 把快照映射成控制台卡片（ConsoleCard / ConsoleRow / ConsoleSettingRow）；
//   ③ 厂商卡片的折叠与忙碌标记（纯 UI 状态）。
//
// 2026-10-26 从 `SettingsModal` 抽出：设置不再是独立模态，而是控制台的一类页面。
// 页面标题与分组由 `ConsoleModal` 统一渲染，本文件不再画顶栏 / 左导航。

import * as React from 'react';
import { useApp } from '../../context.ts';
import { t, type Locale } from '../../i18n/i18n.ts';
import type { ThemePreference } from '../../models/ThemePreference.ts';
import {
  SettingsModel,
  SETTINGS_FIELDS,
  type SettingsField,
  type SettingsTabKey,
} from '../../models/SettingsModel.ts';
import { KeyboardShortcuts, type ShortcutAction } from '../../models/KeyboardShortcuts.ts';
import {
  ConsoleCard,
  ConsoleInfoRow,
  ConsoleRow,
  ConsoleSegmented,
  ConsoleSettingRow,
} from './ConsoleUI.tsx';
import { ProviderCard } from '../settings/ProviderCard.tsx';
import { PermissionTab } from '../tabs/PermissionTab.tsx';
import { DesktopSettingsSection } from '../settings/DesktopSettingsSection.tsx';
import type { Config, ProviderPreset, ProviderProbeResult, Profile } from '../../../types/models.ts';

/** 主题三态（跟随系统 → 深色 → 浅色）。 */
const THEME_PREFS: readonly { key: ThemePreference; icon: 'monitor' | 'moon' | 'sun'; label: string }[] =
  [
    { key: 'system', icon: 'monitor', label: '跟随系统' },
    { key: 'dark', icon: 'moon', label: '深色' },
    { key: 'light', icon: 'sun', label: '浅色' },
  ];

/** 全局快捷键的展示顺序与说明（组合键文案取 `KeyboardShortcuts.label`，不另抄一份）。 */
const GLOBAL_SHORTCUTS: readonly { action: ShortcutAction; label: string }[] = [
  { action: 'palette', label: '打开命令面板' },
  { action: 'newSession', label: '新建会话' },
  { action: 'toggleLeft', label: '收起 / 展开会话栏' },
  { action: 'toggleRight', label: '收起 / 展开右侧面板' },
  { action: 'toggleTheme', label: '切换明暗主题' },
];

/** 全局快捷键解析器只用于取展示文案（无状态，模块级单例）。 */
const SHORTCUT_LABELS = new KeyboardShortcuts();

/** 输入框 / 浮层的内置按键（不经过全局绑定表，但确实由组件实现）。 */
const INPUT_KEYS: readonly { combo: string; label: string }[] = [
  { combo: 'Enter', label: '发送消息（输入框）' },
  { combo: 'Shift+Enter', label: '换行（输入框）' },
  { combo: 'Esc', label: '关闭浮层 / 对话框' },
  { combo: '↑ / ↓', label: '在浮层与选择器里移动' },
  { combo: 'Tab', label: '在控制台与对话框内循环焦点' },
];

/** 厂商目录装载态：把「读取中 / 读取失败 / 目录真的为空」分开。 */
type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * 模型未就绪时的稳定空快照（`useSyncExternalStore` 要求引用稳定）。
 */
const EMPTY_SNAPSHOT = {
  cfg: null,
  baseUrl: '',
  profiles: [] as readonly { id: string; name: string }[],
  activePlugins: '',
  savedHint: '',
  saving: false,
  error: '',
  loadError: '',
};

/** 设置页的入参。 */
export interface SettingsSurfaceProps {
  /** 当前设置页。 */
  tab: SettingsTabKey;
  /** 当前实际生效的主题（系统模式下会随系统变化）。 */
  theme: 'dark' | 'light';
  /** 主题偏好。 */
  themePref: ThemePreference;
  /** 设置主题偏好。 */
  onThemePrefChange: (pref: ThemePreference) => void;
  /** 当前界面语言。 */
  locale: Locale;
  /** 切换界面语言。 */
  onLocaleChange: (locale: Locale) => void;
  /** 当前工作区（只读展示）。 */
  workspacePath: string;
  /** 左栏会话列表是否显示全部项目。 */
  sessionScopeAll: boolean;
  /** 切换会话列表范围。 */
  onToggleSessionsScope: () => void;
  /** 会话栏宽度（px）。 */
  leftWidth: number;
  /** 右侧面板宽度（px）。 */
  rightWidth: number;
  /** 调整会话栏宽度。 */
  onLeftWidthChange: (width: number) => void;
  /** 调整右侧面板宽度。 */
  onRightWidthChange: (width: number) => void;
  /** 控制台内跳到另一页（如「查看快捷键」）。 */
  onNavigate: (key: string) => void;
}

/**
 * 构造设置模型（依赖 useApp 提供的 api / toast / 厂商目录刷新）。
 * @param ctx 应用上下文
 * @returns 模型实例（调用方负责 dispose）
 */
function createModel(ctx: {
  api: ReturnType<typeof useApp>['api'];
  toast: ReturnType<typeof useApp>['toast'];
  refreshModelCatalog: ReturnType<typeof useApp>['refreshModelCatalog'];
}): SettingsModel {
  return new SettingsModel({
    getConfig: () => ctx.api.getConfig(),
    updateConfig: (patch) => ctx.api.updateConfig(patch),
    listProfiles: () => ctx.api.listProfiles() as Promise<Profile[]>,
    getActiveProfile: () => ctx.api.getActiveProfile(),
    applyProfile: (id) => ctx.api.applyProfile(id),
    refreshModelCatalog: ctx.refreshModelCatalog,
    toast: (message, kind) => ctx.toast(message, kind),
  });
}

/**
 * 设置页容器：装载一次配置，按 `tab` 渲染对应卡片。
 * @param props 组件入参
 * @returns 设置页节点
 */
export function SettingsSurface(props: SettingsSurfaceProps): ReactElement {
  const { tab, theme, themePref, locale } = props;
  const { api, toast, refreshModelCatalog } = useApp();

  // 惰性单例：切页不重建模型（避免每切一次都重拉配置）。
  const modelRef = React.useRef<SettingsModel | null>(null);
  if (modelRef.current === null) {
    modelRef.current = createModel({ api, toast, refreshModelCatalog });
  }
  const settings = modelRef.current;

  const snapshot = React.useSyncExternalStore(
    React.useCallback(
      (notify: () => void) => (modelRef.current === null ? () => undefined : modelRef.current.subscribe(notify)),
      [],
    ),
    () => (modelRef.current === null ? EMPTY_SNAPSHOT : modelRef.current.getSnapshot()),
  );

  // 装载一次配置。**不在这里 dispose 模型**：StrictMode 会在开发态重跑 effect，
  // 若第一次清理就把实例标记成 disposed，之后「已保存」提示会永久失效。实例只在
  // 控制台关闭、组件真正卸载后由 GC 回收；定时器最多空跑一次。
  React.useEffect(() => {
    void settings.load();
  }, [settings]);

  // 厂商目录状态（纯 UI）。
  const [providers, setProviders] = React.useState<ProviderPreset[]>([]);
  const [maskedKeys, setMaskedKeys] = React.useState<Record<string, string>>({});
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [probes, setProbes] = React.useState<Record<string, ProviderProbeResult>>({});
  const [modelSel, setModelSel] = React.useState<Record<string, string>>({});
  const [catalogStatus, setCatalogStatus] = React.useState<CatalogStatus>('idle');
  const [catalogError, setCatalogError] = React.useState('');
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [busyById, setBusyById] = React.useState<Record<string, string>>({});
  const catalogReqRef = React.useRef(0);

  /**
   * 拉厂商目录与打码 Key。
   *
   * 目录失败**不静默**：写进状态，由模型页显示原因 + 重试；刷新失败保留上一帧卡片。
   * @returns 无
   */
  const reloadProviders = React.useCallback((): void => {
    const request = ++catalogReqRef.current;
    setCatalogStatus('loading');
    setCatalogError('');
    api
      .modelCatalog()
      .then((result) => {
        if (request !== catalogReqRef.current) return;
        setProviders(result.providers);
        setCatalogStatus('ready');
      })
      .catch((cause: unknown) => {
        if (request !== catalogReqRef.current) return;
        setCatalogError(cause instanceof Error ? cause.message : String(cause));
        setCatalogStatus('error');
      });
    api
      .getConfig()
      .then((config: Config) => {
        const keys = (config as unknown as Record<string, unknown>)['providerKeys'];
        setMaskedKeys(keys !== undefined && typeof keys === 'object' ? (keys as Record<string, string>) : {});
      })
      .catch(() => {
        /* 静默：打码 Key 读不到时保留上一帧；配置错误由 loadError 统一提示 */
      });
  }, [api]);

  React.useEffect(() => {
    if (tab === 'model') reloadProviders();
  }, [tab, reloadProviders]);

  const markBusy = (id: string, kind: string): void => {
    setBusyById((prev) => ({ ...prev, [id]: kind }));
  };

  const clearBusy = (id: string): void => {
    setBusyById((prev) => {
      if (!(prev[id] === undefined)) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return prev;
    });
  };

  const cfg = snapshot.cfg;
  const activeAdapter = (cfg?.modelAdapter as string) ?? '';
  const activeBaseUrl = (cfg?.baseUrl as string) ?? '';

  const isActive = (preset: ProviderPreset): boolean =>
    activeAdapter === preset.adapter && (activeBaseUrl === '' || activeBaseUrl === preset.baseUrl);

  const selectedModelOf = (preset: ProviderPreset, models: string[]): string | undefined =>
    modelSel[preset.id] ??
    (models.includes(cfg?.model ?? '') ? (cfg?.model as string) : models[0]);

  /** 保存某厂商 Key。 */
  const saveKey = async (preset: ProviderPreset): Promise<void> => {
    const key = (drafts[preset.id] ?? '').trim();
    if (key === '') {
      if (maskedKeys[preset.id] === undefined) {
        toast(t('请输入 API Key'), 'err');
        return;
      }
      toast(t('{name} Key 未修改（输入新值才会覆盖）', { name: preset.label }), 'info');
      return;
    }
    markBusy(preset.id, 'key');
    try {
      await api.updateConfig({ setProviderKey: { vendor: preset.id, key } });
      setDrafts((prev) => ({ ...prev, [preset.id]: '' }));
      toast(t('{name} Key 已保存（服务端打码存储）', { name: preset.label }), 'ok');
      reloadProviders();
      refreshModelCatalog?.();
    } catch (e) {
      toast(t('保存失败：{msg}', { msg: (e as Error).message }), 'err');
    } finally {
      clearBusy(preset.id);
    }
  };

  /** 连通检测：真实请求厂商端点，拿回实测模型清单。 */
  const probe = async (preset: ProviderPreset): Promise<void> => {
    markBusy(preset.id, 'probe');
    try {
      const result = (await api.probeModels(preset.id)).providers[0];
      if (result === undefined) {
        toast(t('检测失败：厂商未返回结果'), 'err');
        return;
      }
      setProbes((prev) => ({ ...prev, [preset.id]: result }));
      if (result.ok) {
        toast(
          t('{name} 连通（{count} 个模型，来源 {source}）', {
            name: preset.label,
            count: result.models.length,
            source: result.source,
          }),
          'ok',
        );
        const keep = result.models.includes(cfg?.model ?? '')
          ? (cfg?.model as string)
          : result.models[0];
        setModelSel((prev) => ({ ...prev, [preset.id]: keep ?? preset.defaultModel }));
        refreshModelCatalog?.();
      } else {
        toast(t('{name} 不可用：{msg}', { name: preset.label, msg: result.error ?? t('未知原因') }), 'err');
      }
    } catch (e) {
      toast(t('检测失败：{msg}', { msg: (e as Error).message }), 'err');
    } finally {
      clearBusy(preset.id);
    }
  };

  /** 启用厂商：写入运行时配置，下一条消息即生效。 */
  const enable = async (preset: ProviderPreset): Promise<void> => {
    const models = probes[preset.id]?.models ?? [];
    const model = selectedModelOf(preset, models);
    if (model === undefined) {
      toast(t('没有可用模型，请先检测'), 'err');
      return;
    }
    markBusy(preset.id, 'enable');
    try {
      await api.updateConfig({ enableProvider: preset.id, model });
      toast(t('{name} 已启用（模型 {model}），下一条消息即生效', { name: preset.label, model }), 'ok');
      reloadProviders();
      await settings.reload();
      refreshModelCatalog?.();
    } catch (e) {
      toast(t('启用失败：{msg}', { msg: (e as Error).message }), 'err');
    } finally {
      clearBusy(preset.id);
    }
  };

  const fieldsOf = (which: SettingsTabKey): SettingsField[] =>
    SETTINGS_FIELDS.filter((field) => field.tab === which);

  /** 配置装载失败条（整页只有占位符时，必须说清原因）。 */
  const banner =
    snapshot.loadError === '' ? null : (
      <div className="sp-load-error csl-banner" role="alert">
        <span>{snapshot.loadError}</span>
        <button
          className="csl-btn"
          type="button"
          onClick={() => {
            void settings.load();
            reloadProviders();
          }}
        >
          {t('重试')}
        </button>
      </div>
    );

  const statusText = snapshot.error !== '' ? snapshot.error : snapshot.savedHint;

  /** 常规页：界面语言、工作区、会话范围与产品信息。 */
  const renderGeneral = (): ReactElement => (
    <>
      <ConsoleCard>
        <ConsoleRow label={t('界面语言')} hint={t('选择应用 UI 的显示语言。')}>
          <ConsoleSegmented
            ariaLabel={t('界面语言')}
            value={locale}
            options={[
              { value: 'zh', label: t('中文') },
              { value: 'en', label: 'English' },
            ]}
            onChange={(next) => {
              if (next !== locale) props.onLocaleChange(next);
            }}
          />
        </ConsoleRow>
      </ConsoleCard>

      <ConsoleCard
        footer={t('工作区由启动参数或用户级配置决定，界面内不提供切换——改它等于换一整个项目上下文。')}
      >
        <ConsoleInfoRow label={t('当前工作区')} value={props.workspacePath === '' ? '—' : props.workspacePath} />
        <ConsoleRow
          label={t('会话列表范围')}
          hint={t('只影响左栏列表的筛选，不改变会话归属；「全部项目」会显示其它工作区的存档。')}
        >
          <ConsoleSegmented
            ariaLabel={t('会话列表范围')}
            value={props.sessionScopeAll ? 'all' : 'current'}
            options={[
              { value: 'current', label: t('当前项目') },
              { value: 'all', label: t('全部项目') },
            ]}
            onChange={(next) => {
              if ((next === 'all') !== props.sessionScopeAll) props.onToggleSessionsScope();
            }}
          />
        </ConsoleRow>
      </ConsoleCard>

      <ConsoleCard>
        <ConsoleRow label={t('全局快捷键')} hint={t('命令面板、新建会话、左右栏开合、明暗切换。')}>
          <button className="csl-btn" type="button" onClick={() => props.onNavigate('shortcuts')}>
            {t('查看全部')}
          </button>
        </ConsoleRow>
      </ConsoleCard>

      <ConsoleCard
        footer={t('以上是默认位置；归属根由服务端 OMNI_HOME 决定（默认 ~/.omniharness），--workspace 只切项目。')}
      >
        <ConsoleInfoRow label={t('产品')} value="OmniHarness" />
        <ConsoleInfoRow label={t('配置文件')} value="<OMNI_HOME>/omniharness.json" />
        <ConsoleInfoRow label={t('会话存档')} value="<OMNI_HOME>/sessions/" />
      </ConsoleCard>
    </>
  );

  /** 外观页：主题三态 + 两栏宽度。 */
  const renderAppearance = (): ReactElement => (
    <>
      <ConsoleCard>
        <ConsoleRow
          label={t('主题模式')}
          hint={
            themePref === 'system'
              ? t('当前跟随系统：{theme}', { theme: theme === 'light' ? t('浅色') : t('深色') })
              : t('已锁定为{theme}', { theme: theme === 'light' ? t('浅色') : t('深色') })
          }
        >
          <ConsoleSegmented
            ariaLabel={t('主题')}
            value={themePref}
            options={THEME_PREFS.map((pref) => ({
              value: pref.key,
              label: t(pref.label),
              icon: pref.icon,
            }))}
            onChange={(next) => props.onThemePrefChange(next)}
          />
        </ConsoleRow>
      </ConsoleCard>

      <ConsoleCard
        footer={t('这里与拖动分隔条改的是同一份本机偏好；窄屏（≤880px）下两栏是抽屉，宽度不生效。')}
      >
        <ConsoleRow
          label={t('会话栏宽度')}
          hint={t('范围 180–600 px，当前 {width} px', { width: props.leftWidth })}
        >
          <input
            className="csl-range"
            type="range"
            min={180}
            max={600}
            step={4}
            aria-label={t('会话栏宽度')}
            value={props.leftWidth}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              props.onLeftWidthChange(Number(e.target.value))
            }
          />
        </ConsoleRow>
        <ConsoleRow
          label={t('右侧面板宽度')}
          hint={t('范围 180–760 px，当前 {width} px', { width: props.rightWidth })}
        >
          <input
            className="csl-range"
            type="range"
            min={180}
            max={760}
            step={4}
            aria-label={t('右侧面板宽度')}
            value={props.rightWidth}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              props.onRightWidthChange(Number(e.target.value))
            }
          />
        </ConsoleRow>
      </ConsoleCard>
    </>
  );

  /** 模型页：厂商卡片 + 默认模型 / 端点。 */
  const renderModel = (): ReactElement => {
    const configured = providers.filter((preset) => maskedKeys[preset.id] !== undefined).length;
    return (
      <>
        <ConsoleCard
          title={t('厂商接入')}
          meta={providers.length === 0 ? undefined : t('{done}/{total} 已配置 Key', { done: configured, total: providers.length })}
          description={t('保存 Key → 检测（真实请求厂商端点）→ 启用。凭据由服务端打码存储，界面不回显原文。')}
          actions={
            <button className="csl-btn" type="button" onClick={reloadProviders}>
              {t('刷新')}
            </button>
          }
        >
          {catalogStatus === 'error' ? (
            <div className="sp-load-error" role="alert">
              <span>{t('读取厂商目录失败：{msg}', { msg: catalogError })}</span>
              <button className="csl-btn" type="button" onClick={reloadProviders}>
                {t('重试')}
              </button>
            </div>
          ) : null}
          {providers.length === 0 && catalogStatus !== 'error' ? (
            catalogStatus === 'ready' ? (
              <div className="sp-load-error" role="alert">
                <span>{t('厂商目录为空：defaults/providers.json 可能缺失或不可读。')}</span>
                <button className="csl-btn" type="button" onClick={reloadProviders}>
                  {t('重试')}
                </button>
              </div>
            ) : (
              <p className="csl-empty">{t('读取厂商目录…')}</p>
            )
          ) : null}
          {providers.map((preset) => {
            const auto =
              isActive(preset) || maskedKeys[preset.id] !== undefined || probes[preset.id] !== undefined;
            const isOpen = expanded[preset.id] ?? auto;
            return (
              <div className="sp-card-wrap csl-provider" key={preset.id}>
                <button
                  className="csl-provider-head"
                  type="button"
                  aria-expanded={isOpen ? 'true' : 'false'}
                  onClick={() => setExpanded((prev) => ({ ...prev, [preset.id]: !isOpen }))}
                >
                  <span className="csl-caret" aria-hidden="true">
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span className="csl-provider-name">{preset.label}</span>
                  {maskedKeys[preset.id] === undefined ? null : (
                    <span className="csl-tag">{t('已配置')}</span>
                  )}
                  {isActive(preset) ? <span className="csl-tag on">{t('当前')}</span> : null}
                  <span className="csl-provider-url" title={preset.baseUrl}>
                    {preset.baseUrl}
                  </span>
                </button>
                {isOpen ? (
                  <div className="csl-provider-body">
                    <ProviderCard
                      preset={preset}
                      maskedKey={maskedKeys[preset.id]}
                      probe={probes[preset.id]}
                      draft={drafts[preset.id] ?? ''}
                      busy={busyById[preset.id] ?? ''}
                      active={isActive(preset)}
                      selectedModel={selectedModelOf(preset, probes[preset.id]?.models ?? [])}
                      onDraft={(value) => setDrafts((prev) => ({ ...prev, [preset.id]: value }))}
                      onModelPick={(value) => setModelSel((prev) => ({ ...prev, [preset.id]: value }))}
                      onSaveKey={() => void saveKey(preset)}
                      onProbe={() => void probe(preset)}
                      onEnable={() => void enable(preset)}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </ConsoleCard>

        <ConsoleCard
          title={t('默认模型与端点')}
          description={t('默认模型用于新会话；自定义端点留空即回落厂商默认端点。')}
        >
          {fieldsOf('model').map((field) => (
            <ConsoleSettingRow key={String(field.key)} field={field} model={settings} />
          ))}
        </ConsoleCard>
      </>
    );
  };

  /** 运行时页：适配器 + 沙箱 + 工作区。 */
  const renderRuntime = (): ReactElement => (
    <>
      <ConsoleCard
        title={t('适配器与执行环境')}
        description={t('适配器决定请求协议；沙箱决定命令在什么隔离层里执行。')}
      >
        {fieldsOf('runtime').map((field) => (
          <ConsoleSettingRow key={String(field.key)} field={field} model={settings} />
        ))}
      </ConsoleCard>
      <ConsoleCard
        title={t('工作区')}
        description={t('工作区由启动参数或用户级配置决定（--workspace / ~/.omniharness/omniharness.json），界面内不提供切换。')}
      >
        <ConsoleInfoRow
          label={t('当前工作区')}
          value={cfg?.workspace !== undefined && cfg.workspace !== '' ? String(cfg.workspace) : '—'}
        />
      </ConsoleCard>
    </>
  );

  /** 权限页：全局默认 + 参数级规则编辑器（后者自带卡片）。 */
  const renderPermission = (): ReactElement => (
    <>
      <ConsoleCard
        title={t('审批默认')}
        description={t('这三档是全局默认；按命令 / 参数逐个放行或拦截在下方规则表里编辑。')}
      >
        {fieldsOf('permission').map((field) => (
          <ConsoleSettingRow key={String(field.key)} field={field} model={settings} />
        ))}
      </ConsoleCard>
      <PermissionTab />
    </>
  );

  /** 快捷键页：全局绑定（由绑定表生成，杜绝提示与行为漂移）+ 输入框按键。 */
  const renderShortcuts = (): ReactElement => (
    <>
      <ConsoleCard
        title={t('全局快捷键')}
        description={t('快捷键是只读展示：本版本不提供自定义键位，避免与浏览器保留键冲突。')}
      >
        {GLOBAL_SHORTCUTS.map((row) => (
          <ConsoleRow key={row.action} label={t(row.label)}>
            <kbd className="csl-kbd">{SHORTCUT_LABELS.label(row.action)}</kbd>
          </ConsoleRow>
        ))}
      </ConsoleCard>
      <ConsoleCard title={t('输入框与浮层')} description={t('这些键由各自的组件实现，不是全局监听。')}>
        {INPUT_KEYS.map((row) => (
          <ConsoleRow key={row.combo} label={t(row.label)}>
            <kbd className="csl-kbd">{row.combo}</kbd>
          </ConsoleRow>
        ))}
      </ConsoleCard>
    </>
  );

  const body =
    tab === 'general'
      ? renderGeneral()
      : tab === 'appearance'
        ? renderAppearance()
        : tab === 'model'
          ? renderModel()
          : tab === 'runtime'
            ? renderRuntime()
            : tab === 'permission'
              ? renderPermission()
              : tab === 'shortcuts'
                ? renderShortcuts()
                : <DesktopSettingsSection />;

  return (
    <div className="csl-settings">
      <div
        className={
          'csl-status-line' +
          (statusText === '' ? '' : ' on') +
          (snapshot.error === '' ? '' : ' err')
        }
        role="status"
        aria-live="polite"
      >
        {statusText}
      </div>
      {banner}
      {body}
    </div>
  );
}
