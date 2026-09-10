// 设置面板：加载运行时配置并提供模型适配器 / 模型 / 审批模式 / 沙箱 / 升级审批 / 自动审批 / 浅色主题的调整。
// 所有改动经 api.updateConfig 落盘到 omniharness.json。
//
// 面向对象改造：三个 useRef 改为实例字段（class 组件无 useRef）；
// 配置加载在 componentDidMount 完成并回填 DOM 值；「已保存」提示由 state 驱动 + 定时器自动消隐。

import { React } from '../../deps.js';
import { AppComponent } from '../../base/AppComponent.js';
import type { Config } from '../../../types/models.js';
import { ModelProviders } from './ModelProviders.js';

/** 纵向留白。React 的 style 必须是「属性→值」映射，不能传 CSS 字符串。 */
const SPACER: Record<string, string> = { height: '10px' };

/** 「已保存」提示自动消隐时长（ms）。 */
const HINT_MS = 1500;

export interface SettingsTabProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

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

interface SettingsTabState {
  cfg: Config | null;
  savedHint: string;
}

/** 运行时设置面板。 */
export class SettingsTab extends AppComponent<SettingsTabProps, SettingsTabState> {
  private modelRef: HTMLInputElement | null = null;
  private autoRef: HTMLInputElement | null = null;
  private readonly selectRefs = new Map<string, HTMLSelectElement | null>();

  /** 「已保存」提示的消隐定时器。 */
  private hintTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: SettingsTabProps) {
    super(props);
    this.state = { cfg: null, savedHint: '' };
  }

  override componentDidMount(): void {
    this.api
      .getConfig()
      .then((c) => {
        this.setState({ cfg: c });
        if (this.modelRef) this.modelRef.value = c.model || '';
        if (this.autoRef) this.autoRef.checked = !!c.autoApprove;
        for (const s of SELECTS) {
          const el = this.selectRefs.get(s.key as string);
          if (el) el.value = (c[s.key] as string) || '';
        }
      })
      .catch(() => {
        /* 静默：首次进入后端未就绪时保持「读取中」 */
      });
  }

  override componentWillUnmount(): void {
    if (this.hintTimer !== null) clearTimeout(this.hintTimer);
  }

  /** 落盘配置并闪现「已保存」；失败上抛 toast，绝不清空用户输入。 */
  private save(patch: Record<string, unknown>): void {
    this.api
      .updateConfig(patch)
      .then(() => {
        this.setState({ savedHint: '✓ 已保存' });
        if (this.hintTimer !== null) clearTimeout(this.hintTimer);
        this.hintTimer = setTimeout(() => this.setState({ savedHint: '' }), HINT_MS);
      })
      .catch((e: Error) => this.toast('保存失败：' + e.message, 'err'));
  }

  private readonly onSelectChange = (key: keyof Config, e: Event): void => {
    this.save({ [key]: (e.target as HTMLSelectElement).value });
  };

  private readonly onModelChange = (e: Event): void => {
    const v = (e.target as HTMLInputElement).value.trim();
    this.save(v ? { model: v } : { model: undefined });
  };

  private readonly onAutoApproveChange = (e: Event): void => {
    this.save({ autoApprove: (e.target as HTMLInputElement).checked });
  };

  override render(): ReactElement {
    const { theme, onToggleTheme } = this.props;
    const { cfg, savedHint } = this.state;
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
                  this.selectRefs.set(s.key as string, el);
                }}
                onChange={(e) => this.onSelectChange(s.key, e)}
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
                this.modelRef = el;
              }}
              placeholder="如 gpt-4o / deepseek-v4-flash"
              onChange={this.onModelChange}
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
                this.autoRef = el;
              }}
              onChange={this.onAutoApproveChange}
            />
          </div>
          <div className="switch">
            <span>浅色主题</span>
            <input type="checkbox" checked={theme === 'light'} onChange={onToggleTheme} />
          </div>
        </div>
      </div>
    );
  }
}
