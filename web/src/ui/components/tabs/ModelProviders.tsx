// 模型接入专区（#模型接入页）：厂商卡片 + 各家 Key 独立保存 + 一键连通检测 + 实测模型清单 + 启用。
// 「有 Key 支持接多少显示多少」：未配 Key 的厂商灰显，检测过的厂商展示真实模型下拉。
// 凭据安全：Key 只在输入框短暂存在，保存后服务端打码，UI 永远拿不到原文。
//
// 函数组件范式：七份 state 各用 useState；状态判定继续复用 ProviderStatusResolver
// （零 React，可单测）；样式常量与新值对不变，卡片渲染下沉为模块级函数。

import { React } from '../../deps.js';
import { useApp } from '../../context.js';
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

/** 卡片渲染所需的上下文与回调。 */
interface CardCtx {
  /** 各厂商已保存（打码）的 Key。 */
  maskedKeys: Record<string, string>;
  /** 各厂商的检测结果。 */
  probes: Record<string, ProviderProbeResult>;
  /** 各厂商 Key 输入草稿（未提交，仅存在于内存）。 */
  drafts: Record<string, string>;
  /** 形如 `<id>:<动作>` 的忙碌标记；空串表示空闲。 */
  busy: string;
  /** 该厂商是否为当前生效配置。 */
  isActive: (p: ProviderPreset) => boolean;
  /** 卡片内当前选中的模型。 */
  selectedModelOf: (p: ProviderPreset, models: string[]) => string | undefined;
  /** 草稿变更。 */
  onDraft: (id: string, value: string) => void;
  /** 模型下拉变更。 */
  onModelPick: (id: string, value: string) => void;
  /** 保存 Key。 */
  onSaveKey: (p: ProviderPreset) => void;
  /** 连通检测。 */
  onProbe: (p: ProviderPreset) => void;
  /** 启用该厂商。 */
  onEnable: (p: ProviderPreset) => void;
}

/**
 * 渲染单个厂商卡片：状态点 + Key 输入 + 检测 / 保存 / 启用。
 * @param p 厂商预设
 * @param ctx 卡片上下文与回调
 * @returns 厂商卡片节点
 */
function renderCard(p: ProviderPreset, ctx: CardCtx): ReactElement {
  const st = ProviderStatusResolver.resolve(p, ctx.maskedKeys[p.id], ctx.probes[p.id]);
  const probeResult = ctx.probes[p.id];
  const models = probeResult?.models ?? [];
  const hasKey = ctx.maskedKeys[p.id] !== undefined;
  const selectedModel = ctx.selectedModelOf(p, models);
  const active = ctx.isActive(p);
  return (
    <div key={p.id} style={active ? CARD_ACTIVE : CARD}>
      <div style={ROW}>
        <strong>{p.label}</strong>
        {active ? <span style={ACTIVE_TAG}>● 当前使用</span> : null}
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
          placeholder={hasKey ? `已保存 ${ctx.maskedKeys[p.id]}，输入新值覆盖` : '输入 API Key'}
          value={ctx.drafts[p.id] ?? ''}
          onInput={(e: Event) => ctx.onDraft(p.id, (e.target as HTMLInputElement).value)}
        />
        <button className="ghost" disabled={ctx.busy !== ''} onClick={() => ctx.onSaveKey(p)}>
          保存 Key
        </button>
        <button className="ghost" disabled={ctx.busy !== ''} onClick={() => ctx.onProbe(p)}>
          检测
        </button>
      </div>
      {probeResult?.ok && models.length > 0 ? (
        <div style={{ ...ROW, marginTop: '8px' }}>
          <select
            style={INPUT}
            value={selectedModel}
            onChange={(e: Event) => ctx.onModelPick(p.id, (e.target as HTMLSelectElement).value)}
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            className="ghost"
            disabled={ctx.busy !== '' || !selectedModel}
            onClick={() => ctx.onEnable(p)}
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

/**
 * 模型接入面板：厂商目录、Key 管理、连通检测与启用。
 * @returns 模型接入节点
 */
export function ModelProviders(): ReactElement {
  const { api, toast, refreshModelCatalog } = useApp();
  const [providers, setProviders] = React.useState<ProviderPreset[]>([]);
  const [maskedKeys, setMaskedKeys] = React.useState<Record<string, string>>({});
  const [active, setActive] = React.useState<{ adapter?: string; baseUrl?: string; model?: string }>({});
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [probes, setProbes] = React.useState<Record<string, ProviderProbeResult>>({});
  const [modelSel, setModelSel] = React.useState<Record<string, string>>({});
  /** 形如 `<id>:<动作>` 的忙碌标记；空串表示空闲。 */
  const [busy, setBusy] = React.useState<string>('');

  /** 拉取厂商目录与当前生效配置（失败静默保留上一帧）。 */
  const reload = (): void => {
    api
      .modelCatalog()
      .then((r) => setProviders(r.providers))
      .catch(() => {
        /* 静默：目录不可用时保留上一帧 */
      });
    api
      .getConfig()
      .then((c) => {
        const pk = (c as Record<string, unknown>)['providerKeys'];
        setMaskedKeys(
          pk !== undefined && typeof pk === 'object' ? (pk as Record<string, string>) : {},
        );
        setActive({
          adapter: c.modelAdapter,
          baseUrl: c.baseUrl as string | undefined,
          model: c.model,
        });
      })
      .catch(() => {
        /* 静默：配置不可用时保留上一帧 */
      });
  };

  // 挂载拉取厂商目录与生效配置（[] 有意：只在进入该页时拉一次）。
  React.useEffect(() => {
    reload();
  }, []);

  /**
   * 该厂商是否为当前生效配置。
   * @param p 厂商预设
   * @returns 是否生效
   */
  const isActive = (p: ProviderPreset): boolean =>
    active.adapter === p.adapter && (active.baseUrl ?? p.baseUrl) === p.baseUrl;

  /**
   * 卡片内当前选中的模型：优先用户选择，其次沿用当前生效模型，最后取清单首个。
   * @param p 厂商预设
   * @param models 可选模型清单
   * @returns 选中模型名（无可用模型时为 undefined）
   */
  const selectedModelOf = (p: ProviderPreset, models: string[]): string | undefined =>
    modelSel[p.id] ??
    (isActive(p) && active.model && models.includes(active.model) ? active.model : models[0]);

  /**
   * 保存 Key：空值且此前未保存过 → fail-closed 提示，不发请求。
   * @param p 厂商预设
   */
  const saveKey = async (p: ProviderPreset): Promise<void> => {
    const key = (drafts[p.id] ?? '').trim();
    if (key === '' && maskedKeys[p.id] === undefined) {
      toast('请输入 API Key', 'err');
      return;
    }
    setBusy(p.id + ':key');
    try {
      await api.updateConfig({ setProviderKey: { vendor: p.id, key } });
      setDrafts((prev) => ({ ...prev, [p.id]: '' }));
      toast(`${p.label} Key 已保存（服务端打码存储）`, 'ok');
      reload();
      refreshModelCatalog?.();
    } catch (e) {
      toast('保存失败：' + (e as Error).message, 'err');
    } finally {
      setBusy('');
    }
  };

  /**
   * 连通检测：真实请求厂商端点，拿回实测模型清单。
   * @param p 厂商预设
   */
  const probe = async (p: ProviderPreset): Promise<void> => {
    setBusy(p.id + ':probe');
    try {
      const r = await api.probeModels(p.id);
      const result = r.providers[0];
      setProbes((prev) => ({ ...prev, [p.id]: result }));
      if (result.ok) {
        toast(
          `${p.label} 连通 ✅（${result.models.length} 个模型，来源 ${result.source}）`,
          'ok',
        );
        const keep =
          isActive(p) && active.model && result.models.includes(active.model)
            ? active.model
            : result.models[0];
        setModelSel((prev) => ({ ...prev, [p.id]: keep ?? p.defaultModel }));
        refreshModelCatalog?.();
      } else {
        toast(`${p.label} 不可用：${result.error ?? '未知原因'}`, 'err');
      }
    } catch (e) {
      toast('检测失败：' + (e as Error).message, 'err');
    } finally {
      setBusy('');
    }
  };

  /**
   * 启用厂商：把模型写进运行时配置，下一条消息即生效。
   * @param p 厂商预设
   */
  const enable = async (p: ProviderPreset): Promise<void> => {
    const models = probes[p.id]?.models ?? [];
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
  };

  const ctx: CardCtx = {
    maskedKeys,
    probes,
    drafts,
    busy,
    isActive,
    selectedModelOf,
    onDraft: (id, value) => setDrafts((prev) => ({ ...prev, [id]: value })),
    onModelPick: (id, value) => setModelSel((prev) => ({ ...prev, [id]: value })),
    onSaveKey: (p) => void saveKey(p),
    onProbe: (p) => void probe(p),
    onEnable: (p) => void enable(p),
  };

  return (
    <div>
      <h3 style={{ margin: '4px 0 8px' }}>模型接入</h3>
      <div style={HINT}>
        填 Key → 保存 → 检测（真实请求厂商端点）→ 启用。有 Key 支持接多少显示多少；凭据服务端打码存储，UI 不回显原文。
      </div>
      <div style={{ marginTop: '10px' }}>{providers.map((p) => renderCard(p, ctx))}</div>
    </div>
  );
}
