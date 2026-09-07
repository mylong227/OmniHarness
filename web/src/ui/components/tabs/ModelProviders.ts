// 模型接入专区（#模型接入页）：厂商卡片 + 各家 Key 独立保存 + 一键连通检测 + 实测模型清单 + 启用。
// 「有 Key 支持接多少显示多少」：未配 Key 的厂商灰显，检测过的厂商展示真实模型下拉。
// 凭据安全：Key 只在输入框短暂存在，保存后服务端打码，UI 永远拿不到原文。

import { html, React } from '../../deps.js';
import { useApp } from '../../context.js';
import type { ProviderPreset, ProviderProbeResult } from '../../../types/models.js';

/** 状态点样式。 */
const DOT: Record<string, string> = { height: '10px', width: '10px', borderRadius: '50%', display: 'inline-block', marginRight: '6px' };

export function ModelProviders(): ReactElement {
  const { api, toast, refreshModelCatalog } = useApp();
  const [providers, setProviders] = React.useState<ProviderPreset[]>([]);
  const [maskedKeys, setMaskedKeys] = React.useState<Record<string, string>>({});
  const [active, setActive] = React.useState<{ adapter?: string; baseUrl?: string; model?: string }>({});
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [probes, setProbes] = React.useState<Record<string, ProviderProbeResult>>({});
  const [modelSel, setModelSel] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState('');

  const reload = React.useCallback(() => {
    api
      .modelCatalog()
      .then((r) => setProviders(r.providers))
      .catch(() => {
        /* 静默 */
      });
    api
      .getConfig()
      .then((c) => {
        const pk = (c as Record<string, unknown>)['providerKeys'];
        setMaskedKeys(pk !== undefined && typeof pk === 'object' ? (pk as Record<string, string>) : {});
        setActive({ adapter: c.modelAdapter, baseUrl: c.baseUrl as string | undefined, model: c.model });
      })
      .catch(() => {
        /* 静默 */
      });
  }, [api]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function saveKey(p: ProviderPreset) {
    const key = (drafts[p.id] ?? '').trim();
    if (key === '' && maskedKeys[p.id] === undefined) {
      toast('请输入 API Key', 'err');
      return;
    }
    setBusy(p.id + ':key');
    try {
      await api.updateConfig({ setProviderKey: { vendor: p.id, key } });
      setDrafts((d) => ({ ...d, [p.id]: '' }));
      toast(`${p.label} Key 已保存（服务端打码存储）`, 'ok');
      reload();
      refreshModelCatalog?.();
    } catch (e) {
      toast('保存失败：' + (e as Error).message, 'err');
    } finally {
      setBusy('');
    }
  }

  async function probe(p: ProviderPreset) {
    setBusy(p.id + ':probe');
    try {
      const r = await api.probeModels(p.id);
      const result = r.providers[0];
      setProbes((prev) => ({ ...prev, [p.id]: result }));
      if (result.ok) {
        toast(`${p.label} 连通 ✅（${result.models.length} 个模型，来源 ${result.source}）`, 'ok');
        const keep =
          isActive(p) && active.model && result.models.includes(active.model)
            ? active.model
            : result.models[0];
        setModelSel((sel) => ({ ...sel, [p.id]: keep ?? p.defaultModel }));
        refreshModelCatalog?.();
      } else {
        toast(`${p.label} 不可用：${result.error ?? '未知原因'}`, 'err');
      }
    } catch (e) {
      toast('检测失败：' + (e as Error).message, 'err');
    } finally {
      setBusy('');
    }
  }

  async function enable(p: ProviderPreset) {
    const probe = probes[p.id];
    const models = probe?.models ?? [];
    const model =
      modelSel[p.id] ??
      (isActive(p) && active.model && models.includes(active.model) ? active.model : models[0]);
    if (!model) {
      toast('没有可用模型，请先检测', 'err');
      return;
    }
    setBusy(p.id + ':enable');
    try {
      await api.updateConfig({ enableProvider: p.id, model });
      toast(`${p.label} 已启用（模型 ${model}），下一条消息即生效`, 'ok');
      reload();
      refreshModelCatalog?.();
    } catch (e) {
      toast('启用失败：' + (e as Error).message, 'err');
    } finally {
      setBusy('');
    }
  }

  function statusOf(p: ProviderPreset): { dot: string; text: string; ok: boolean } {
    const probe = probes[p.id];
    if (probe !== undefined) {
      if (probe.ok) return { dot: '#3fb950', text: `可用 · ${probe.models.length} 个模型`, ok: true };
      return { dot: '#f85149', text: probe.configured ? `不可用 · ${probe.error ?? ''}` : '未配置 Key', ok: false };
    }
    if (maskedKeys[p.id] !== undefined) return { dot: '#d29922', text: `已保存 ${maskedKeys[p.id]}（未实测）`, ok: false };
    return { dot: '#8b949e', text: p.needsKey ? '未配置 Key' : '免 Key', ok: false };
  }

  function isActive(p: ProviderPreset): boolean {
    return active.adapter === p.adapter && (active.baseUrl ?? p.baseUrl) === p.baseUrl;
  }

  const cardStyle: Record<string, string> = {
    border: '1px solid var(--border, #30363d)',
    borderRadius: '8px',
    padding: '12px',
    marginBottom: '10px',
  };
  const activeCardStyle: Record<string, string> = { ...cardStyle, borderColor: '#3fb950' };
  const rowStyle: Record<string, string> = { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' };
  const inputStyle: Record<string, string> = { flex: '1', minWidth: '180px' };
  
  const hintStyle: Record<string, string> = { fontSize: '12px', opacity: '0.65' };

  return html`<div>
    <h3 style=${{ margin: '4px 0 8px' }}>模型接入</h3>
    <div style=${hintStyle}>填 Key → 保存 → 检测（真实请求厂商端点）→ 启用。有 Key 支持接多少显示多少；凭据服务端打码存储，UI 不回显原文。</div>
    <div style=${{ marginTop: '10px' }}>
      ${providers.map((p) => {
        const st = statusOf(p);
        const probeResult = probes[p.id];
        const models = probeResult?.models ?? [];
        const hasKey = maskedKeys[p.id] !== undefined;
        const selectedModel =
          modelSel[p.id] ??
          (isActive(p) && active.model && models.includes(active.model) ? active.model : models[0]);
        const canEnable = models.length > 0 && selectedModel;
        return html`<div key=${p.id} style=${isActive(p) ? activeCardStyle : cardStyle}>
          <div style=${rowStyle}>
            <strong>${p.label}</strong>
            ${isActive(p) ? html`<span style=${{ color: '#3fb950', fontSize: '12px' }}>● 当前使用</span>` : null}
            <span style=${hintStyle}>${p.baseUrl}</span>
          </div>
          <div style=${{ ...rowStyle, marginTop: '8px' }}>
            <span style=${{ ...DOT, background: st.dot }}></span>
            <span style=${hintStyle}>${st.text}</span>
          </div>
          <div style=${{ ...rowStyle, marginTop: '8px' }}>
            <input
              type="password"
              style=${inputStyle}
              placeholder=${hasKey ? `已保存 ${maskedKeys[p.id]}，输入新值覆盖` : '输入 API Key'}
              value=${drafts[p.id] ?? ''}
              onInput=${(e: Event) => setDrafts((d) => ({ ...d, [p.id]: (e.target as HTMLInputElement).value }))}
            />
            <button className="ghost" disabled=${busy !== ''} onClick=${() => saveKey(p)}>保存 Key</button>
            <button className="ghost" disabled=${busy !== ''} onClick=${() => probe(p)}>检测</button>
          </div>
          ${probeResult?.ok && models.length > 0
            ? html`<div style=${{ ...rowStyle, marginTop: '8px' }}>
                <select
                  style=${{ flex: '1', minWidth: '180px' }}
                  value=${selectedModel}
                  onChange=${(e: Event) => setModelSel((sel) => ({ ...sel, [p.id]: (e.target as HTMLSelectElement).value }))}
                >
                  ${models.map((m) => html`<option key=${m} value=${m}>${m}</option>`)}
                </select>
                <button className="ghost" disabled=${busy !== '' || !canEnable} onClick=${() => enable(p)}>启用此厂商</button>
              </div>`
            : html`<div style=${{ ...hintStyle, marginTop: '6px' }}>
                ${probeResult && !probeResult.ok
                  ? `检测未通过：${probeResult.error ?? '未知原因'}（保存有效 Key 后重试）`
                  : hasKey
                    ? '已保存 Key，点「检测」拉取真实可用模型清单'
                    : '未配置 Key：保存 Key → 检测 → 启用后才会显示可用模型'}
              </div>`}
        </div>`;
      })}
    </div>
  </div>`;
}
