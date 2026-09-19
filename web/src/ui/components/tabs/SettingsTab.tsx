// 设置面板：加载运行时配置并提供模型适配器 / 模型 / 审批模式 / 沙箱 / 升级审批 / 自动审批 / 浅色主题的调整。
// 所有改动经 api.updateConfig 落盘到 omniharness.json；保存成功后重新拉取配置刷新表单，
// 涉及模型 / 适配器的改动额外刷新厂商目录，坐实「改动即时生效，UI 与生效配置不漂移」。
//
// 函数组件范式：配置 / 提示 / base-url / 配置集清单 / 生效插件各一个 useState；
// 表单主体为非受控（useRef 保存 DOM 引用，含 select 的 Map 引用），加载后回填 DOM 值；
// 「已保存」提示由 state 驱动 + useRef 持有的定时器自动消隐（卸载时清理对称）。

import { React } from '../../deps.js';
import { useApp } from '../../context.js';
import type { Config, Profile } from '../../../types/models.js';
import { ModelProviders } from './ModelProviders.js';

/** 纵向留白。React 的 style 必须是「属性→值」映射，不能传 CSS 字符串。 */
const SPACER: Record<string, string> = { height: '10px' };

/** 「已保存」提示自动消隐时长（ms）。 */
const HINT_MS = 1500;

/** 改动后需要重拉厂商目录（model.catalog）的配置键：模型下拉与厂商标题随之刷新。 */
const CATALOG_KEYS: readonly string[] = ['model', 'modelAdapter'];

/** SettingsTab 组件的入参。 */
export interface SettingsTabProps {
  /** 当前主题（浅色开关的受控值）。 */
  theme: 'dark' | 'light';
  /** 切换主题。 */
  onToggleTheme: () => void;
}

/** 一个下拉设置项。 */
interface SettingSelect {
  key: keyof Config;
  label: string;
  options: string[];
}

const SELECTS: readonly SettingSelect[] = [
  { key: 'modelAdapter', label: '模型适配器', options: ['mock', 'openai', 'anthropic', 'responses'] },
  { key: 'approval', label: '审批模式', options: ['auto', 'rules', 'ask'] },
  {
    key: 'sandbox',
    label: '沙箱',
    options: ['passthrough', 'policy', 'restricted', 'landlock', 'seatbelt', 'bwrap'],
  },
  { key: 'escalation', label: '升级审批', options: ['deny', 'ask', 'auto'] },
];

/** 配置集下拉项（收敛 profile 切换到设置面板，与 API key / base-url 同处可改）。 */
interface ProfileOption {
  id: string;
  name: string;
}

/**
 * 运行时设置面板：模型接入 + 运行时配置 + 配置集切换。
 * @param props 组件入参
 * @returns 设置面板节点
 */
export function SettingsTab(props: SettingsTabProps): ReactElement {
  const { theme, onToggleTheme } = props;
  const { api, toast, refreshModelCatalog } = useApp();
  const [cfg, setCfg] = React.useState<Config | null>(null);
  const [savedHint, setSavedHint] = React.useState<string>('');
  /** 自定义模型 base-url（OpenAI 兼容端点），留空＝清除覆盖、回落厂商默认。 */
  const [baseUrl, setBaseUrl] = React.useState<string>('');
  /** 配置集（profile）清单。 */
  const [profiles, setProfiles] = React.useState<ProfileOption[]>([]);
  /** 当前生效插件（profile.apply 后回显，便于确认收敛生效）。 */
  const [activePlugins, setActivePlugins] = React.useState<string>('');
  const modelRef = React.useRef<HTMLInputElement | null>(null);
  const autoRef = React.useRef<HTMLInputElement | null>(null);
  const baseUrlRef = React.useRef<HTMLInputElement | null>(null);
  const selectRefs = React.useRef<Map<string, HTMLSelectElement | null>>(new Map());
  /** 「已保存」提示的消隐定时器。 */
  const hintRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 拉取配置集清单与当前生效插件（收敛 profile 状态到设置面板）。 */
  const reloadProfiles = async (): Promise<void> => {
    try {
      const list = await api.listProfiles();
      const active = await api.getActiveProfile();
      setProfiles(list.map((p: Profile) => ({ id: p.id, name: p.name })));
      setActivePlugins((active.plugins ?? []).join('、'));
    } catch {
      /* 静默：profile 服务不可用时不阻断设置渲染 */
    }
  };

  /**
   * 用服务端配置回填表单（挂载首拉与保存后重拉共用，避免两处取值漂移）。
   * @param c 服务端配置
   */
  const applyConfig = (c: Config): void => {
    setCfg(c);
    setBaseUrl((c.baseUrl as string) ?? '');
    if (modelRef.current) modelRef.current.value = c.model || '';
    if (autoRef.current) autoRef.current.checked = !!c.autoApprove;
    if (baseUrlRef.current) baseUrlRef.current.value = (c.baseUrl as string) ?? '';
    for (const s of SELECTS) {
      const el = selectRefs.current.get(s.key as string);
      if (el) el.value = (c[s.key] as string) || '';
    }
  };

  /** 重新拉取运行时配置并刷新表单；失败静默（保留当前表单值，不打断用户）。 @returns 异步完成 */
  const reload = async (): Promise<void> => {
    try {
      applyConfig(await api.getConfig());
    } catch {
      /* 静默：配置不可用时保留当前表单值 */
    }
  };

  // 挂载拉取配置并回填非受控表单；同时拉配置集清单。卸载清理「已保存」定时器。
  React.useEffect(() => {
    void reload();
    void reloadProfiles();
    return () => {
      if (hintRef.current !== null) clearTimeout(hintRef.current);
    };
  }, [api]);

  /**
   * 落盘配置并闪现「已保存」；成功后重新拉取配置刷新表单（坐实改动即时生效），
   * 命中模型 / 适配器时额外刷新厂商目录（Composer 模型下拉与厂商标题同步）。
   * 失败上抛 toast，绝不清空用户输入。
   * @param patch 配置补丁
   */
  const save = (patch: Record<string, unknown>): void => {
    api
      .updateConfig(patch)
      .then(async () => {
        setSavedHint('✓ 已保存');
        if (hintRef.current !== null) clearTimeout(hintRef.current);
        hintRef.current = setTimeout(() => setSavedHint(''), HINT_MS);
        await reload();
        if (Object.keys(patch).some((k) => CATALOG_KEYS.includes(k))) refreshModelCatalog?.();
      })
      .catch((e: Error) => toast('保存失败：' + e.message, 'err'));
  };

  /**
   * 下拉设置变更 → 落盘。
   * @param key 配置键
   * @param e 变更事件
   */
  const onSelectChange = (key: keyof Config, e: Event): void => {
    save({ [key]: (e.target as HTMLSelectElement).value });
  };

  /**
   * 模型名变更 → 落盘（留空回落 undefined）。
   * @param e 变更事件
   */
  const onModelChange = (e: Event): void => {
    const v = (e.target as HTMLInputElement).value.trim();
    save(v ? { model: v } : { model: undefined });
  };

  /**
   * 自动审批开关 → 落盘。
   * @param e 变更事件
   */
  const onAutoApproveChange = (e: Event): void => {
    save({ autoApprove: (e.target as HTMLInputElement).checked });
  };

  /**
   * 自定义 base-url 变更：即时写回配置；**留空＝清除覆盖**（回落厂商默认端点）。
   * 服务端约定：`null` 表示显式清除（`undefined` 是 no-op、空串会被当成真实端点写坏 URL 拼装），
   * 故这里留空发送 `null`——与 `serverConfigStore.update` 的清除语义成对。
   * @param e 变更事件
   */
  const onBaseUrlChange = (e: Event): void => {
    const v = (e.target as HTMLInputElement).value.trim();
    setBaseUrl(v);
    save(v ? { baseUrl: v } : { baseUrl: null });
  };

  /**
   * 应用选中的配置集（profile.apply 即时生效，刷新后回显当前插件）。
   * @param id 配置集 id
   */
  const applyProfile = async (id: string): Promise<void> => {
    if (id === '') return;
    try {
      await api.applyProfile(id);
      toast('已应用配置集', 'ok');
      await reloadProfiles();
    } catch (e) {
      toast('应用配置集失败：' + (e as Error).message, 'err');
    }
  };

  return (
    <div>
      <ModelProviders />
      <hr
        style={{
          border: 'none',
          borderTop: '1px solid var(--border, #30363d)',
          margin: '14px 0',
        }}
      />
      <h3 style={{ margin: '4px 0 8px' }}>运行时设置</h3>
      <div id="cfgView">
        {cfg ? (
          <div className="kv">
            <span className="k">工作区</span>
            <span className="v">{cfg.workspace || '—'}</span>
          </div>
        ) : (
          <div className="empty">读取中…</div>
        )}
      </div>
      <div style={SPACER}></div>
      <div className="form">
        {SELECTS.map((s) => (
          <label key={s.key as string}>
            {s.label}
            <select
              ref={(el: HTMLSelectElement | null) => {
                selectRefs.current.set(s.key as string, el);
              }}
              onChange={(e) => onSelectChange(s.key, e)}
            >
              {s.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label>
          模型名
          <input
            type="text"
            ref={(el: HTMLInputElement | null) => {
              modelRef.current = el;
            }}
            placeholder="如 gpt-4o / deepseek-v4-flash"
            onChange={onModelChange}
          />
        </label>
        <label>
          自定义 Base URL
          <input
            type="text"
            ref={(el: HTMLInputElement | null) => {
              baseUrlRef.current = el;
            }}
            placeholder="OpenAI 兼容端点（留空＝清除覆盖，回落厂商默认）"
            value={baseUrl}
            onChange={onBaseUrlChange}
          />
        </label>
        <div className="saved" id="savedHint">
          {savedHint}
        </div>
        <div className="switch">
          <span>自动审批（免人工确认）</span>
          <input
            type="checkbox"
            ref={(el: HTMLInputElement | null) => {
              autoRef.current = el;
            }}
            onChange={onAutoApproveChange}
          />
        </div>
        <div className="switch">
          <span>浅色主题</span>
          <input type="checkbox" checked={theme === 'light'} onChange={onToggleTheme} />
        </div>
      </div>
      <div style={SPACER}></div>
      <h3 style={{ margin: '4px 0 8px' }}>配置集（Profile）</h3>
      <div className="form">
        <label>
          切换配置集
          <select
            value=""
            onChange={(e: Event) => void applyProfile((e.target as HTMLSelectElement).value)}
          >
            <option value="">选择并应用…</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="kv">
          <span className="k">当前生效插件</span>
          <span className="v">{activePlugins === '' ? '（默认）' : activePlugins}</span>
        </div>
      </div>
    </div>
  );
}
