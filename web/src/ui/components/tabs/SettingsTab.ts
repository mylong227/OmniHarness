// 设置面板：加载运行时配置并提供模型适配器 / 模型 / 审批模式 / 沙箱 / 升级审批 / 自动审批 / 浅色主题的调整。
// 所有改动经 api.updateConfig 落盘到 omniharness.json。

import { html, React } from '../../deps.js';
import { useApp } from '../../context.js';
import type { Config } from '../../../types/models.js';
import { ModelProviders } from './ModelProviders.js';

/** 纵向留白。React 的 style 必须是「属性→值」映射，不能传 CSS 字符串。 */
const SPACER: Record<string, string> = { height: '10px' };

export interface SettingsTabProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

const SELECTS: { key: keyof Config; label: string; options: string[] }[] = [
  { key: 'modelAdapter', label: '模型适配器', options: ['mock', 'openai', 'anthropic', 'responses'] },
  { key: 'approval', label: '审批模式', options: ['auto', 'rules', 'ask'] },
  {
    key: 'sandbox',
    label: '沙箱',
    options: ['passthrough', 'policy', 'restricted', 'landlock', 'seatbelt', 'bwrap'],
  },
  { key: 'escalation', label: '升级审批', options: ['deny', 'ask', 'auto'] },
];

export function SettingsTab(props: SettingsTabProps): ReactElement {
  const { theme, onToggleTheme } = props;
  const { api, toast } = useApp();
  const [cfg, setCfg] = React.useState<Config | null>(null);
  const [savedHint, setSavedHint] = React.useState('');
  const modelRef = React.useRef<HTMLInputElement | null>(null);
  const autoRef = React.useRef<HTMLInputElement | null>(null);
  const selectRefs = React.useRef<Record<string, HTMLSelectElement | null>>({});

  React.useEffect(() => {
    api
      .getConfig()
      .then((c) => {
        setCfg(c);
        if (modelRef.current) modelRef.current.value = c.model || '';
        if (autoRef.current) autoRef.current.checked = !!c.autoApprove;
        for (const s of SELECTS) {
          const el = selectRefs.current[s.key as string];
          if (el) el.value = (c[s.key] as string) || '';
        }
      })
      .catch(() => {
        /* 静默 */
      });
  }, [api]);

  function save(patch: Record<string, unknown>) {
    api
      .updateConfig(patch)
      .then(() => {
        setSavedHint('✓ 已保存');
        setTimeout(() => setSavedHint((h) => (h === '✓ 已保存' ? '' : h)), 1500);
      })
      .catch((e: Error) => toast('保存失败：' + e.message, 'err'));
  }

  function onSelectChange(key: keyof Config, e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    save({ [key]: v });
  }

  return html`<div>
    <${ModelProviders} />
    <hr style=${{ border: 'none', borderTop: '1px solid var(--border, #30363d)', margin: '14px 0' }} />
    <h3 style=${{ margin: '4px 0 8px' }}>运行时设置</h3>
    <div id="cfgView">
      ${cfg
        ? html`<div className="kv"><span className="k">工作区</span><span className="v">${cfg.workspace || '—'}</span></div>`
        : html`<div className="empty">读取中…</div>`}
    </div>
    <div style=${SPACER}></div>
    <div className="form">
      ${SELECTS.map(
        (s) =>
          html`<label key=${s.key as string}
            >${s.label}
            <select
              ref=${(el: HTMLSelectElement | null) => {
                selectRefs.current[s.key as string] = el;
              }}
              onChange=${(e: Event) => onSelectChange(s.key, e)}
            >
              ${s.options.map((o) => html`<option key=${o} value=${o}>${o}</option>`)}
            </select>
          </label>`,
      )}
      <label
        >模型名
        <input type="text" ref=${modelRef} placeholder="如 gpt-4o / deepseek-v4-flash" onChange=${(e: Event) => {
          const v = (e.target as HTMLInputElement).value.trim();
          save(v ? { model: v } : { model: undefined });
        }} />
      </label>
      <div className="saved" id="savedHint">${savedHint}</div>
      <div className="switch">
        <span>自动审批（免人工确认）</span>
        <input
          type="checkbox"
          ref=${autoRef}
          onChange=${(e: Event) => save({ autoApprove: (e.target as HTMLInputElement).checked })}
        />
      </div>
      <div className="switch">
        <span>浅色主题</span>
        <input type="checkbox" checked=${theme === 'light'} onChange=${onToggleTheme} />
      </div>
    </div>
  </div>`;
}
