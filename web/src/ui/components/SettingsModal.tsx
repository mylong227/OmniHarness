// 设置面板（模态）：左栏分栏导航 + 右栏内容。
//
// ## 为什么从「右栏面板」改成「模态」（2026-10-17 用户要求）
//
// 旧实现把设置当成右栏第 11 个面板。三个问题：
//   1. **语义不对**：右栏那些面板（工具/变更/指标/编排…）都是"看这摊活的状态"，
//      而设置是"改全局配置"。把配置混进监控面板列表，等于让用户在一个为"读"设计的
//      容器里做"写"。
//   2. **可达性差**：入口在「全部面板」菜单里，与 16 个面板并列，找一次要点两步。
//   3. **形状不适配**：设置是多栏目的（模型/运行时/权限/外观/配置集），挤在右栏
//      一条竖列里只能一路往下排，越加越长。
// 现在：入口固定在**左栏页脚**（设置按钮），打开为居中模态，内部分栏。
//
// ## 状态归属
//
// 读写在 `models/SettingsModel.ts`（零 React，可单测）；本组件是**薄视图**：
// 用 `useSyncExternalStore` 订阅模型快照，把 vnode 映射出来。
// 组件内只保留三类**纯 UI** 状态：厂商卡片草稿/检测结果/忙碌标记，以及当前分栏。
//
// ## 无障碍
//
// role="dialog" + aria-modal + aria-label；Esc 关闭；关闭按钮有 aria-label；
// 分栏导航是 role="tablist" + role="tab"（aria-selected）——不靠颜色表达选中。
//
// **焦点陷阱（2026-10-17 补）**：打开时把焦点移进模态、Tab/Shift+Tab 在框内绕圈、
// 关闭时把焦点还给打开它的那个元素。此前只有 aria-modal 而没有真的圈住焦点，
// Tab 能走到背后的会话列表上——那是 WCAG 2.4.3 的实质缺陷（详见 models/focusTrap.ts）。

import * as React from 'react';
import { icon } from '../models/Icon.ts';
import { useApp } from '../context.ts';
import { emptyNote } from '../format.ts';
import { t, type Locale } from '../i18n/i18n.ts';
import { focusableWithin, trapTab } from '../models/focusTrap.ts';
import {
  SettingsModel,
  SETTINGS_FIELDS,
  SETTINGS_TABS,
  type SettingsTabKey,
  type SettingsField,
} from '../models/SettingsModel.ts';
import { ProviderCard } from './settings/ProviderCard.tsx';
import type { ProviderPreset, ProviderProbeResult, Config, Profile } from '../../types/models.ts';

/** 关闭键。 */
const ESC = 'Escape';

/**
 * 模型未就绪时的稳定空快照。
 * 为什么需要常量而不是每次写 `{cfg:null,…}`：`useSyncExternalStore` 的 getSnapshot
 * 每次返回**新对象**会被判定为"变了"⇒ 无限重渲染。必须返回同一个引用。
 */
const EMPTY_SNAPSHOT = {
  cfg: null,
  baseUrl: '',
  profiles: [] as readonly { id: string; name: string }[],
  activePlugins: '',
  savedHint: '',
  saving: false,
  error: '',
};

/** SettingsModal 组件的入参。 */
export interface SettingsModalProps {
  /** 是否打开（关闭时不渲染任何节点）。 */
  open: boolean;
  /** 打开时的初始分栏（含「从审批弹窗跳权限」这条路径）。 */
  tab: SettingsTabKey;
  /** 当前主题。 */
  theme: 'dark' | 'light';
  /** 切换主题。 */
  onToggleTheme: () => void;
  /** 当前界面语言。 */
  locale: Locale;
  /** 切换界面语言。 */
  onLocaleChange: (l: Locale) => void;
  /** 关闭。 */
  onClose: () => void;
  /** 切分栏（受控，便于"跳到权限"这类外部驱动）。 */
  onTabChange: (tab: SettingsTabKey) => void;
  /**
   * 打开另一个功能面板（凭据/插件/权限规则等仍有专属面板的配置面）。
   * 用于"更重的编辑去专属面板"，避免设置模态变成什么都塞的杂物间。
   */
  onOpenPanel: (key: string) => void;
}

/**
 * 构造设置模型（依赖 useApp 提供的 api / toast / 厂商目录刷新）。
 * @param ctx 应用上下文（api / toast / refreshModelCatalog）
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
    toast: (m, k) => ctx.toast(m, k),
  });
}

/**
 * 设置模态：分栏导航 + 内容区。
 * @param props 组件入参
 * @returns 模态节点（open=false 时为 null）
 */
export function SettingsModal(props: SettingsModalProps): ReactElement | null {
  const { open, tab, theme, locale, onClose, onTabChange } = props;
  const { api, toast, refreshModelCatalog } = useApp();

  // 惰性单例：模型只在首次打开时构造（关掉再开不重建，避免重复拉配置）。
  const modelRef = React.useRef<SettingsModel | null>(null);
  if (open && modelRef.current === null) {
    modelRef.current = createModel({ api, toast, refreshModelCatalog });
  }
  const settings = modelRef.current;

  // 订阅模型快照（零依赖 useSyncExternalStore；模型保证"变了才换引用"）。
  const snapshot = React.useSyncExternalStore(
    React.useCallback(
      (fn: () => void) => {
        const m = modelRef.current;
        if (m === null) return () => undefined;
        return m.subscribe(fn);
      },
      [],
    ),
    () => {
      const m = modelRef.current;
      return m === null ? EMPTY_SNAPSHOT : m.getSnapshot();
    },
  );

  // 首次打开装载一次；卸载时释放模型（清掉"已保存"定时器与订阅）。
  React.useEffect(() => {
    if (!open || settings === null) return undefined;
    void settings.load();
    return () => {
      settings.dispose();
      modelRef.current = null;
    };
  }, [open, settings]);

  /** 模态根元素（焦点陷阱的作用域；同时是可聚焦兜底目标，见下方 tabIndex）。 */
  const dialogRef = React.useRef<HTMLDivElement | null>(null);

  // Esc 关闭 + Tab 圈定焦点：挂 window 而非容器，避免焦点在输入框里时按键丢失。
  //
  // 为什么 Tab 也在这里处理：一旦焦点跑出模态（例如打开瞬间焦点还在背后按钮上），
  // 容器上的 onKeyDown 就收不到事件了。挂 window 才能把它**拉回来**。
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === ESC) {
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        // trapTab 只在"需要绕回"或"焦点在框外"时返回 true；中间位置交给浏览器自然移动。
        if (trapTab(dialogRef.current, e.shiftKey)) e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 打开把焦点移进模态、关闭还给原来的元素。
  //
  // 为什么用 rAF 延后一帧：首次打开时内容（厂商目录、分栏正文）是异步挂载的，
  // effect 运行的这一刻可能还没有任何可聚焦子元素；此时退而聚焦容器本身。
  React.useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement as HTMLElement | null;
    const id = requestAnimationFrame(() => {
      const first = focusableWithin(dialogRef.current)[0];
      (first ?? dialogRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(id);
      // 归还焦点：opener 可能已被卸载（例如打开它的按钮所在面板关了），故先查 isConnected。
      if (opener !== null && opener.isConnected) opener.focus();
    };
  }, [open]);

  // 厂商栏状态（纯 UI）：草稿 / 检测结果 / 模型选择 / 忙碌标记 / 目录。
  const [providers, setProviders] = React.useState<ProviderPreset[]>([]);
  const [maskedKeys, setMaskedKeys] = React.useState<Record<string, string>>({});
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [probes, setProbes] = React.useState<Record<string, ProviderProbeResult>>({});
  const [modelSel, setModelSel] = React.useState<Record<string, string>>({});
  // 忙碌标记**按厂商分开**（`{ [providerId]: 'key' | 'probe' | 'enable' }`）。
  //
  // ⚠️ 2026-10-17 修一个真实的串台缺陷：此前是单个字符串 `'<id>:<kind>'`，后果有两个——
  //   ① `ProviderCard` 只做 `disabled = busy !== ''`，于是 A 厂商在检测时**所有厂商**的
  //      保存/检测/启用按钮一起变灰（用户会以为界面卡死）；
  //   ② A 完成时 `setBusy('')` 会把 B 刚点下的转圈一起清掉，B 的操作看起来"没反应"。
  // 改成按 id 记录后，每个厂商只影响自己那一张卡，且各操作的收尾只清自己那把键。
  const [busyById, setBusyById] = React.useState<Record<string, string>>({});

  /**
   * 标记某厂商正在执行某操作。
   * @param id 厂商 id
   * @param kind 操作种类（key / probe / enable）
   * @returns 无
   */
  const markBusy = (id: string, kind: string): void => {
    setBusyById((prev) => ({ ...prev, [id]: kind }));
  };

  /**
   * 清掉某厂商的忙碌标记（**只清自己那把键**，不影响其它厂商）。
   * @param id 厂商 id
   * @returns 无
   */
  const clearBusy = (id: string): void => {
    setBusyById((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});

  /** 拉厂商目录与生效配置（失败静默保留上一帧）。 */
  const reloadProviders = React.useCallback((): void => {
    api
      .modelCatalog()
      .then((r) => setProviders(r.providers))
      .catch(() => {
        /* 静默：目录不可用时保留上一帧 */
      });
    api
      .getConfig()
      .then((c: Config) => {
        const pk = (c as unknown as Record<string, unknown>)['providerKeys'];
        setMaskedKeys(
          pk !== undefined && typeof pk === 'object' ? (pk as Record<string, string>) : {},
        );
      })
      .catch(() => {
        /* 静默：配置不可用时保留上一帧 */
      });
  }, [api]);

  React.useEffect(() => {
    if (open && tab === 'model') reloadProviders();
  }, [open, tab, reloadProviders]);

  if (!open) return null;
  if (settings === null) return null;

  const cfg = snapshot.cfg;
  const activeAdapter = (cfg?.modelAdapter as string) ?? '';
  const activeBaseUrl = (cfg?.baseUrl as string) ?? '';

  /**
   * 该厂商是否当前生效。
   * @param p 厂商预设
   * @returns 是否生效
   */
  const isActive = (p: ProviderPreset): boolean =>
    activeAdapter === p.adapter && (activeBaseUrl === '' ? true : activeBaseUrl === p.baseUrl);

  /**
   * 卡片内选中的模型：用户选择 > 当前生效模型（若在该厂商清单里）> 清单首个。
   * @param p 厂商预设
   * @param models 可选模型
   * @returns 选中模型
   */
  const selectedModelOf = (p: ProviderPreset, models: string[]): string | undefined =>
    modelSel[p.id] ?? (models.includes(cfg?.model ?? '') ? (cfg?.model as string) : models[0]);

  /** 保存某厂商 Key。 */
  const saveKey = async (p: ProviderPreset): Promise<void> => {
    const key = (drafts[p.id] ?? '').trim();
    if (key === '') {
      if (maskedKeys[p.id] === undefined) {
        toast(t('请输入 API Key'), 'err');
        return;
      }
      // 输入框为空且已有打码 Key：**不是清除**。服务端把空串当"删除凭据"，
      // 直接发请求会静默抹掉已存 Key（2026-10-18 审查 R-01）。
      toast(t('{name} Key 未修改（输入新值才会覆盖）', { name: p.label }), 'info');
      return;
    }
    markBusy(p.id, 'key');
    try {
      await api.updateConfig({ setProviderKey: { vendor: p.id, key } });
      setDrafts((prev) => ({ ...prev, [p.id]: '' }));
      toast(t('{name} Key 已保存（服务端打码存储）', { name: p.label }), 'ok');
      reloadProviders();
      refreshModelCatalog?.();
    } catch (e) {
      toast(t('保存失败：{msg}', { msg: (e as Error).message }), 'err');
    } finally {
      clearBusy(p.id);
    }
  };

  /** 连通检测：真实请求厂商端点，拿回实测模型清单。 */
  const probe = async (p: ProviderPreset): Promise<void> => {
    markBusy(p.id, 'probe');
    try {
      const r = await api.probeModels(p.id);
      const result = r.providers[0];
      setProbes((prev) => ({ ...prev, [p.id]: result }));
      if (result.ok) {
        toast(t('{name} 连通（{count} 个模型，来源 {source}）', { name: p.label, count: result.models.length, source: result.source }), 'ok');
        const keep = result.models.includes(cfg?.model ?? '') ? (cfg?.model as string) : result.models[0];
        setModelSel((prev) => ({ ...prev, [p.id]: keep ?? p.defaultModel }));
        refreshModelCatalog?.();
      } else {
        toast(t('{name} 不可用：{msg}', { name: p.label, msg: result.error ?? t('未知原因') }), 'err');
      }
    } catch (e) {
      toast(t('检测失败：{msg}', { msg: (e as Error).message }), 'err');
    } finally {
      clearBusy(p.id);
    }
  };

  /** 启用厂商：写入运行时配置，下一条消息即生效。 */
  const enable = async (p: ProviderPreset): Promise<void> => {
    const models = probes[p.id]?.models ?? [];
    const model = selectedModelOf(p, models);
    if (model === undefined) {
      toast(t('没有可用模型，请先检测'), 'err');
      return;
    }
    markBusy(p.id, 'enable');
    try {
      await api.updateConfig({ enableProvider: p.id, model });
      toast(t('{name} 已启用（模型 {model}），下一条消息即生效', { name: p.label, model }), 'ok');
      reloadProviders();
      // 注意命名：局部变量 `model` 是选中的模型名（字符串），设置模型实例叫 `settings`
      // （早先两者同名，`settings.reload()` 被 TS 解析成 String.reload ⇒ 编译期报错）。
      await settings.reload();
      refreshModelCatalog?.();
    } catch (e) {
      toast(t('启用失败：{msg}', { msg: (e as Error).message }), 'err');
    } finally {
      clearBusy(p.id);
    }
  };

  /** 渲染一个设置字段（下拉 / 文本 / 开关）。 */
  const renderField = (f: SettingsField): ReactElement => {
    const value = settings.valueOf(f.key);
    if (f.kind === 'switch') {
      return (
        <label className="sp-field" key={f.key as string}>
          <span className="sp-field-label">{t(f.label)}</span>
          <input
            type="checkbox"
            className="sp-switch"
            aria-label={t(f.label)}
            checked={settings.boolOf(f.key)}
            onChange={(e: React.SyntheticEvent) =>
              void settings.saveField(f, (e.target as HTMLInputElement).checked)
            }
          />
          {f.hint !== undefined ? <span className="sp-hint">{t(f.hint)}</span> : null}
        </label>
      );
    }
    if (f.kind === 'select') {
      return (
        <label className="sp-field" key={f.key as string}>
          <span className="sp-field-label">{t(f.label)}</span>
          <select
            className="sp-input"
            aria-label={t(f.label)}
            value={value}
            onChange={(e: React.SyntheticEvent) => void settings.saveField(f, (e.target as HTMLSelectElement).value)}
          >
            {(f.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          {f.hint !== undefined ? <span className="sp-hint">{t(f.hint)}</span> : null}
        </label>
      );
    }
    return (
      <label className="sp-field" key={f.key as string}>
        <span className="sp-field-label">{t(f.label)}</span>
        <input
          type="text"
          className="sp-input"
          aria-label={t(f.label)}
          placeholder={f.placeholder === undefined ? '' : t(f.placeholder)}
          value={value}
          onChange={(e: React.SyntheticEvent) => void settings.saveField(f, (e.target as HTMLInputElement).value)}
        />
        {f.hint !== undefined ? <span className="sp-hint">{t(f.hint)}</span> : null}
      </label>
    );
  };

  /** 取某分栏的字段。 */
  const fieldsOf = (t: SettingsTabKey): SettingsField[] => SETTINGS_FIELDS.filter((f) => f.tab === t);

  /** 「模型」栏：厂商卡片 + 默认模型 / 自定义端点。 */
  const renderModelTab = (): ReactElement => {
    const configured = providers.filter((p) => maskedKeys[p.id] !== undefined).length;
    return (
      <>
        <div className="sp-sec">
          <div className="sp-sec-head">
            <h3 className="sp-sec-title">{t('厂商接入')}</h3>
            <span className="sp-sec-meta">
              {providers.length === 0 ? '' : t('{done}/{total} 已配置 Key', { done: configured, total: providers.length })}
            </span>
          </div>
          <p className="sp-hint">
            {t('保存 Key → 检测（真实请求厂商端点）→ 启用。凭据由服务端打码存储，界面不回显原文。')}
          </p>
          {providers.length === 0 ? (
            // emptyNote 的 `icon` 选项收的是**图标名**（IconName），不是 vnode——
            // 传 icon(...) 的返回值会在编译期报 TS2322（这里刚踩过一次）。
            emptyNote(t('读取厂商目录…'), { icon: 'package' })
          ) : (
            <div className="sp-cards">
              {providers.map((p) => {
                // 折叠口径：当前生效厂商与已配置 Key 的厂商默认展开，其余折成一行标题。
                const auto = isActive(p) || maskedKeys[p.id] !== undefined || probes[p.id] !== undefined;
                const isOpen = expanded[p.id] ?? auto;
                return (
                  <div className="sp-card-wrap" key={p.id}>
                    <button
                      className="sp-card-toggle"
                      aria-expanded={isOpen ? 'true' : 'false'}
                      onClick={() => setExpanded((prev) => ({ ...prev, [p.id]: !isOpen }))}
                    >
                      {/* 语义符号（▾ / ▸）而不是图标：Icon.ts 是可枚举的图标集，
                          折叠箭头属于"行内状态标记"，与既有 .tc-chevron 同一口径。 */}
                      <span className="sp-caret" aria-hidden="true">
                        {isOpen ? '▾' : '▸'}
                      </span>
                      <span className="sp-card-toggle-name">{p.label}</span>
                      {maskedKeys[p.id] !== undefined ? <span className="sp-mini">{t('已配置')}</span> : null}
                      {isActive(p) ? <span className="sp-mini">{t('当前')}</span> : null}
                    </button>
                    {isOpen ? (
                      <ProviderCard
                        preset={p}
                        maskedKey={maskedKeys[p.id]}
                        probe={probes[p.id]}
                        draft={drafts[p.id] ?? ''}
                        busy={busyById[p.id] ?? ''}
                        active={isActive(p)}
                        selectedModel={selectedModelOf(p, probes[p.id]?.models ?? [])}
                        onDraft={(v) => setDrafts((prev) => ({ ...prev, [p.id]: v }))}
                        onModelPick={(v) => setModelSel((prev) => ({ ...prev, [p.id]: v }))}
                        onSaveKey={() => void saveKey(p)}
                        onProbe={() => void probe(p)}
                        onEnable={() => void enable(p)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="sp-sec">
          <h3 className="sp-sec-title">{t('默认模型与端点')}</h3>
          <div className="sp-fields">{fieldsOf('model').map(renderField)}</div>
        </div>
      </>
    );
  };

  /** 「运行时」栏：适配器 + 沙箱 + 工作区（只读）。 */
  const renderRuntimeTab = (): ReactElement => (
    <>
      <div className="sp-sec">
        <h3 className="sp-sec-title">{t('适配器与执行环境')}</h3>
        <div className="sp-fields">{fieldsOf('runtime').map(renderField)}</div>
      </div>
      <div className="sp-sec">
        <h3 className="sp-sec-title">{t('工作区')}</h3>
        <div className="sp-kv">
          <span className="sp-k">{t('当前工作区')}</span>
          <span className="sp-v">{cfg?.workspace !== undefined && cfg.workspace !== '' ? cfg.workspace : '—'}</span>
        </div>
        <p className="sp-hint">
          {t('工作区由启动参数或用户级配置决定（`--workspace` / `~/.omniharness/omniharness.json`），界面内不提供切换——改它等于换一整个项目上下文。')}
        </p>
      </div>
    </>
  );

  /** 「权限」栏：审批模式 + 升级策略 + 免确认开关 + 指向参数级规则面板。 */
  const renderPermissionTab = (): ReactElement => (
    <>
      <div className="sp-sec">
        <h3 className="sp-sec-title">{t('审批')}</h3>
        <div className="sp-fields">{fieldsOf('permission').map(renderField)}</div>
      </div>
      <div className="sp-sec">
        <h3 className="sp-sec-title">{t('参数级规则')}</h3>
        <p className="sp-hint">
          {t('上面三档是**全局默认**；要按命令/参数逐个放行或拦截（例如只允许 `git status`），在「权限」面板里编辑规则表。')}
        </p>
        <button className="ghost" onClick={() => props.onOpenPanel('permission')}>
          {t('打开权限规则面板')}
        </button>
      </div>
    </>
  );

  /** 「外观」栏：主题（明暗两态用反白块表达，不靠色相）+ 语言（与主题同面板，用户口径）。 */
  const renderAppearanceTab = (): ReactElement => (
    <>
      <div className="sp-sec">
        <h3 className="sp-sec-title">{t('主题')}</h3>
        <div className="sp-seg" role="radiogroup" aria-label={t('主题')}>
          {(['dark', 'light'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={theme === m ? 'true' : 'false'}
              className={'sp-seg-item' + (theme === m ? ' on' : '')}
              onClick={() => {
                if (theme !== m) props.onToggleTheme();
              }}
            >
              {icon(m === 'dark' ? 'moon' : 'sun', { size: 13 })}
              {m === 'dark' ? t('深色') : t('浅色')}
            </button>
          ))}
        </div>
        <p className="sp-hint">{t('两套主题共用同一组 token（黑/白/灰），只交换明度方向；切换后立即生效并记住选择。')}</p>
      </div>
      <div className="sp-sec">
        <h3 className="sp-sec-title">{t('语言')}</h3>
        <div className="sp-seg" role="radiogroup" aria-label={t('语言')}>
          {(['zh', 'en'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={locale === m ? 'true' : 'false'}
              className={'sp-seg-item' + (locale === m ? ' on' : '')}
              onClick={() => {
                if (locale !== m) props.onLocaleChange(m);
              }}
            >
              {m === 'zh' ? t('中文') : t('English')}
            </button>
          ))}
        </div>
        <p className="sp-hint">{t('界面文案即时切换并记住选择。')}</p>
      </div>
    </>
  );

  /** 「配置集」栏：切换 + 生效插件 + 指向插件面板。 */
  const renderProfilesTab = (): ReactElement => (
    <div className="sp-sec">
      <h3 className="sp-sec-title">{t('配置集（Profile）')}</h3>
      <label className="sp-field">
        <span className="sp-field-label">{t('应用配置集')}</span>
        <select
          className="sp-input"
          aria-label={t('应用配置集')}
          value=""
          onChange={(e: React.SyntheticEvent) => void settings.applyProfile((e.target as HTMLSelectElement).value)}
        >
          <option value="">{t('选择并应用…')}</option>
          {snapshot.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="sp-hint">{t('应用后立即生效，当前生效插件见下')}</span>
      </label>
      <div className="sp-kv">
        <span className="sp-k">{t('当前生效插件')}</span>
        <span className="sp-v">{snapshot.activePlugins === '' ? t('（默认）') : snapshot.activePlugins}</span>
      </div>
      <p className="sp-hint">{t('新建 / 删除 / 打包配置集在「配置集」面板里完成。')}</p>
      <button className="ghost" onClick={() => props.onOpenPanel('profiles')}>
        {t('打开配置集面板')}
      </button>
    </div>
  );

  const body =
    tab === 'model'
      ? renderModelTab()
      : tab === 'runtime'
        ? renderRuntimeTab()
        : tab === 'permission'
          ? renderPermissionTab()
          : tab === 'appearance'
            ? renderAppearanceTab()
            : renderProfilesTab();

  return (
    <div
      className="sp-ovl"
      role="presentation"
      onClick={(e: React.MouseEvent) => {
        // 点遮罩关闭（点内容不关）：用 target === currentTarget 判定，避免冒泡误关。
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="sp"
        role="dialog"
        aria-modal="true"
        aria-label={t('设置')}
        ref={dialogRef}
        // tabIndex=-1：不参与 Tab 序列，但允许被程序性聚焦（框内无可聚焦元素时兜底）。
        tabIndex={-1}
      >
        <div className="sp-top">
          <span className="sp-top-title">
            {icon('gear', { size: 14 })}
            {t('设置')}
          </span>
          <span className={'sp-saved' + (snapshot.savedHint !== '' ? ' on' : '')} role="status" aria-live="polite">
            {snapshot.error !== '' ? snapshot.error : snapshot.savedHint}
          </span>
          <button className="iconbtn" aria-label={t('关闭设置')} title={t('关闭（Esc）')} onClick={onClose}>
            {icon('x', { size: 15 })}
          </button>
        </div>
        <div className="sp-body">
          <nav className="sp-nav" role="tablist" aria-label={t('设置分栏')}>
            {SETTINGS_TABS.map((td) => (
              <button
                key={td.key}
                role="tab"
                aria-selected={tab === td.key ? 'true' : 'false'}
                className={'sp-nav-item' + (tab === td.key ? ' on' : '')}
                title={t(td.hint)}
                onClick={() => onTabChange(td.key)}
              >
                {t(td.label)}
              </button>
            ))}
          </nav>
          <div className="sp-content">{body}</div>
        </div>
      </div>
    </div>
  );
}
