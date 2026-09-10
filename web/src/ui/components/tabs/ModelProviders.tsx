// 模型接入专区（#模型接入页）：厂商卡片 + 各家 Key 独立保存 + 一键连通检测 + 实测模型清单 + 启用。
// 「有 Key 支持接多少显示多少」：未配 Key 的厂商灰显，检测过的厂商展示真实模型下拉。
// 凭据安全：Key 只在输入框短暂存在，保存后服务端打码，UI 永远拿不到原文。
//
// 面向对象改造：六份 state 收敛为单一 state 对象；状态判定下沉到 ProviderStatusResolver
// （零 React，可单测）；样式常量提到模块级，避免每次 render 重建对象。

import { React } from '../../deps.js';
import { AppComponent } from '../../base/AppComponent.js';
import { ProviderStatusResolver } from '../../models/ProviderStatus.js';
import type { ProviderPreset, ProviderProbeResult } from '../../../types/models.js';

/** 状态点样式。 */
const DOT: Record<string, string> = {
  height: '10px',
  width: '10px',
  borderRadius: '50%',
  display: 'inline-block',
  marginRight: '6px',
};

const CARD: Record<string, string> = {
  border: '1px solid var(--border, #30363d)',
  borderRadius: '8px',
  padding: '12px',
  marginBottom: '10px',
};
const CARD_ACTIVE: Record<string, string> = { ...CARD, borderColor: '#3fb950' };
const ROW: Record<string, string> = {
  display: 'flex',
  gap: '8px',
  alignItems: 'center',
  flexWrap: 'wrap',
};
const INPUT: Record<string, string> = { flex: '1', minWidth: '180px' };
const HINT: Record<string, string> = { fontSize: '12px', opacity: '0.65' };
const ACTIVE_TAG: Record<string, string> = { color: '#3fb950', fontSize: '12px' };

interface ModelProvidersState {
  providers: ProviderPreset[];
  maskedKeys: Record<string, string>;
  active: { adapter?: string; baseUrl?: string; model?: string };
  /** 各厂商 Key 输入草稿（未提交，仅存在于内存）。 */
  drafts: Record<string, string>;
  probes: Record<string, ProviderProbeResult>;
  modelSel: Record<string, string>;
  /** 形如 `<id>:<动作>` 的忙碌标记；空串表示空闲。 */
  busy: string;
}

/** 模型接入面板。 */
export class ModelProviders extends AppComponent<Record<string, never>, ModelProvidersState> {
  constructor(props: Record<string, never>) {
    super(props);
    this.state = {
      providers: [],
      maskedKeys: {},
      active: {},
      drafts: {},
      probes: {},
      modelSel: {},
      busy: '',
    };
  }

  override componentDidMount(): void {
    this.reload();
  }

  /** 拉取厂商目录与当前生效配置。 */
  private reload(): void {
    this.api
      .modelCatalog()
      .then((r) => this.setState({ providers: r.providers }))
      .catch(() => {
        /* 静默：目录不可用时保留上一帧 */
      });
    this.api
      .getConfig()
      .then((c) => {
        const pk = (c as Record<string, unknown>)['providerKeys'];
        this.setState({
          maskedKeys:
            pk !== undefined && typeof pk === 'object' ? (pk as Record<string, string>) : {},
          active: { adapter: c.modelAdapter, baseUrl: c.baseUrl as string | undefined, model: c.model },
        });
      })
      .catch(() => {
        /* 静默：配置不可用时保留上一帧 */
      });
  }

  /** 保存 Key：空值且此前未保存过 → fail-closed 提示，不发请求。 */
  private async saveKey(p: ProviderPreset): Promise<void> {
    const { drafts, maskedKeys } = this.state;
    const key = (drafts[p.id] ?? '').trim();
    if (key === '' && maskedKeys[p.id] === undefined) {
      this.toast('请输入 API Key', 'err');
      return;
    }
    this.setState({ busy: p.id + ':key' });
    try {
      await this.api.updateConfig({ setProviderKey: { vendor: p.id, key } });
      this.setState({ drafts: { ...drafts, [p.id]: '' } });
      this.toast(`${p.label} Key 已保存（服务端打码存储）`, 'ok');
      this.reload();
      this.refreshModelCatalog();
    } catch (e) {
      this.toast('保存失败：' + (e as Error).message, 'err');
    } finally {
      this.setState({ busy: '' });
    }
  }

  /** 连通检测：真实请求厂商端点，拿回实测模型清单。 */
  private async probe(p: ProviderPreset): Promise<void> {
    this.setState({ busy: p.id + ':probe' });
    try {
      const r = await this.api.probeModels(p.id);
      const result = r.providers[0];
      this.setState((prev) => ({ probes: { ...prev.probes, [p.id]: result } }));
      if (result.ok) {
        this.toast(
          `${p.label} 连通 ✅（${result.models.length} 个模型，来源 ${result.source}）`,
          'ok',
        );
        const { active } = this.state;
        const keep =
          this.isActive(p) && active.model && result.models.includes(active.model)
            ? active.model
            : result.models[0];
        this.setState((prev) => ({
          modelSel: { ...prev.modelSel, [p.id]: keep ?? p.defaultModel },
        }));
        this.refreshModelCatalog();
      } else {
        this.toast(`${p.label} 不可用：${result.error ?? '未知原因'}`, 'err');
      }
    } catch (e) {
      this.toast('检测失败：' + (e as Error).message, 'err');
    } finally {
      this.setState({ busy: '' });
    }
  }

  /** 启用厂商：把模型写进运行时配置，下一条消息即生效。 */
  private async enable(p: ProviderPreset): Promise<void> {
    const { probes, modelSel, active } = this.state;
    const models = probes[p.id]?.models ?? [];
    const model =
      modelSel[p.id] ??
      (this.isActive(p) && active.model && models.includes(active.model) ? active.model : models[0]);
    if (!model) {
      this.toast('没有可用模型，请先检测', 'err');
      return;
    }
    this.setState({ busy: p.id + ':enable' });
    try {
      await this.api.updateConfig({ enableProvider: p.id, model });
      this.toast(`${p.label} 已启用（模型 ${model}），下一条消息即生效`, 'ok');
      this.reload();
      this.refreshModelCatalog();
    } catch (e) {
      this.toast('启用失败：' + (e as Error).message, 'err');
    } finally {
      this.setState({ busy: '' });
    }
  }

  /** 该厂商是否为当前生效配置。 */
  private isActive(p: ProviderPreset): boolean {
    const { active } = this.state;
    return active.adapter === p.adapter && (active.baseUrl ?? p.baseUrl) === p.baseUrl;
  }

  /** 卡片内当前选中的模型：优先用户选择，其次沿用当前生效模型，最后取清单首个。 */
  private selectedModelOf(p: ProviderPreset, models: string[]): string | undefined {
    const { modelSel, active } = this.state;
    return (
      modelSel[p.id] ??
      (this.isActive(p) && active.model && models.includes(active.model) ? active.model : models[0])
    );
  }

  private renderCard(p: ProviderPreset): ReactElement {
    const { maskedKeys, probes, drafts, busy } = this.state;
    const st = ProviderStatusResolver.resolve(p, maskedKeys[p.id], probes[p.id]);
    const probeResult = probes[p.id];
    const models = probeResult?.models ?? [];
    const hasKey = maskedKeys[p.id] !== undefined;
    const selectedModel = this.selectedModelOf(p, models);
    return (
      <div key={p.id} style={this.isActive(p) ? CARD_ACTIVE : CARD}>
        <div style={ROW}>
          <strong>{p.label}</strong>
          {this.isActive(p) ? <span style={ACTIVE_TAG}>● 当前使用</span> : null}
          <span style={HINT}>{p.baseUrl}</span>
        </div>
        <div style={{ ...ROW, marginTop: '8px' }}>
          <span style={{ ...DOT, background: st.dot }}></span>
          <span style={HINT}>{st.text}</span>
        </div>
        <div style={{ ...ROW, marginTop: '8px' }}>
          <input
            type="password"
            style={INPUT}
            placeholder={hasKey ? `已保存 ${maskedKeys[p.id]}，输入新值覆盖` : '输入 API Key'}
            value={drafts[p.id] ?? ''}
            onInput={(e: Event) =>
              this.setState((prev) => ({
                drafts: { ...prev.drafts, [p.id]: (e.target as HTMLInputElement).value },
              }))
            }
          />
          <button className="ghost" disabled={busy !== ''} onClick={() => void this.saveKey(p)}>
            保存 Key
          </button>
          <button className="ghost" disabled={busy !== ''} onClick={() => void this.probe(p)}>
            检测
          </button>
        </div>
        {probeResult?.ok && models.length > 0 ? (
          <div style={{ ...ROW, marginTop: '8px' }}>
            <select
              style={INPUT}
              value={selectedModel}
              onChange={(e: Event) =>
                this.setState((prev) => ({
                  modelSel: { ...prev.modelSel, [p.id]: (e.target as HTMLSelectElement).value },
                }))
              }
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button
              className="ghost"
              disabled={busy !== '' || !selectedModel}
              onClick={() => void this.enable(p)}
            >
              启用此厂商
            </button>
          </div>
        ) : (
          <div style={{ ...HINT, marginTop: '6px' }}>
            {probeResult && !probeResult.ok
              ? `检测未通过：${probeResult.error ?? '未知原因'}（保存有效 Key 后重试）`
              : hasKey
                ? '已保存 Key，点「检测」拉取真实可用模型清单'
                : '未配置 Key：保存 Key → 检测 → 启用后才会显示可用模型'}
          </div>
        )}
      </div>
    );
  }

  override render(): ReactElement {
    const { providers } = this.state;
    return (
      <div>
        <h3 style={{ margin: '4px 0 8px' }}>模型接入</h3>
        <div style={HINT}>
          填 Key → 保存 → 检测（真实请求厂商端点）→ 启用。有 Key 支持接多少显示多少；凭据服务端打码存储，UI 不回显原文。
        </div>
        <div style={{ marginTop: '10px' }}>{providers.map((p) => this.renderCard(p))}</div>
      </div>
    );
  }
}
