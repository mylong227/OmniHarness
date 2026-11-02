// 设置页「模型与厂商」栏的取数与动作：厂商目录 / 打码 Key / Key 草稿 / 连通检测 / 启用。
//
// 2026-11-02 从 `SettingsSurface` 抽出：原实现把 9 个 `useState` + 4 个动作塞在 499 行的
// 容器组件里（`check.mjs` 函数体行数铁律）。拆成若干小 hook 后，容器只做组合；以下语义
// 与抽出前逐字一致：
//   · 目录失败**不静默**：写进状态，由模型页显示原因 + 重试；刷新失败保留上一帧卡片；
//   · 每个动作都带 `busy` 标记，`finally` 清除；
//   · 目录请求用递增请求号丢弃过期响应（快速重试时旧响应不能覆盖新结果）。

import * as React from 'react';
import { t } from '../../i18n/i18n.ts';
import type { SettingsTabKey } from '../../models/SettingsModel.ts';
import type { AppContextValue } from '../../context.ts';
import type { Config, ProviderPreset, ProviderProbeResult } from '../../../types/models.ts';

/** 厂商目录装载态：把「读取中 / 读取失败 / 目录真的为空」分开。 */
export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

/** 模型页要用到的厂商目录状态与动作。 */
export interface ProviderCatalogState {
  /** 厂商预设清单。 */
  providers: ProviderPreset[];
  /** 已保存（打码）的 Key：厂商 id → 打码值。 */
  maskedKeys: Record<string, string>;
  /** Key 输入草稿（仅存在于内存，保存后清空）。 */
  drafts: Record<string, string>;
  /** 连通检测结果：厂商 id → 结果。 */
  probes: Record<string, ProviderProbeResult>;
  /** 用户手选的模型：厂商 id → 模型名。 */
  modelSel: Record<string, string>;
  /** 目录装载态。 */
  catalogStatus: CatalogStatus;
  /** 目录读取失败原因（空串＝无）。 */
  catalogError: string;
  /** 形如 `<id>:<action>` 的忙碌标记。 */
  busyById: Record<string, string>;
  /** 折叠状态：厂商 id → 是否展开（缺省时按自动规则）。 */
  expanded: Record<string, boolean>;
  /** 重新拉厂商目录与打码 Key。 */
  reloadProviders: () => void;
  /** 展开 / 折叠某厂商。 */
  setExpandedOpen: (id: string, open: boolean) => void;
  /** 修改某厂商的 Key 草稿。 */
  setDraft: (id: string, value: string) => void;
  /** 手选某厂商的模型。 */
  setModelChoice: (id: string, value: string) => void;
  /** 保存某厂商 Key。 */
  saveKey: (preset: ProviderPreset) => Promise<void>;
  /** 连通检测：真实请求厂商端点，拿回实测模型清单。 */
  probe: (preset: ProviderPreset) => Promise<void>;
  /** 启用厂商：写入运行时配置，下一条消息即生效。 */
  enable: (preset: ProviderPreset) => Promise<void>;
}

/** 设置页传给目录 hook 的依赖。 */
export interface ProviderCatalogOptions {
  /** 服务端客户端。 */
  api: AppContextValue['api'];
  /** 当前设置页（只有模型页会触发目录装载）。 */
  tab: SettingsTabKey;
  /** 提示通道。 */
  toast: AppContextValue['toast'];
  /** 厂商目录刷新。 */
  refreshModelCatalog: AppContextValue['refreshModelCatalog'];
  /** 启用厂商后重拉设置快照（`settings.reload()`）。 */
  onReloadSettings: () => Promise<void>;
  /** 当前服务端配置（未装载时为 null）。 */
  cfg: Config | null;
}

/**
 * 厂商是否为当前生效厂商。
 * @param preset 厂商预设
 * @param adapter 当前适配器
 * @param baseUrl 当前自定义端点（空串＝未覆盖）
 * @returns 是否生效
 */
export function isActiveProvider(
  preset: ProviderPreset,
  adapter: string,
  baseUrl: string,
): boolean {
  return adapter === preset.adapter && (baseUrl === '' || baseUrl === preset.baseUrl);
}

/**
 * 卡片里当前选中的模型：用户手选 > 当前生效模型（若在清单里）> 清单第一个。
 * @param preset 厂商预设
 * @param models 候选模型（检测结果或空清单）
 * @param choices 用户手选记录
 * @param activeModel 当前生效模型
 * @returns 选中模型；无候选时为 undefined
 */
export function selectedModelFor(
  preset: ProviderPreset,
  models: string[],
  choices: Record<string, string>,
  activeModel: string,
): string | undefined {
  return choices[preset.id] ?? (models.includes(activeModel) ? activeModel : models[0]);
}

/** 忙碌标记状态与动作。 */
interface BusyControls {
  /** 形如 `<id>:<action>` 的忙碌标记。 */
  busyById: Record<string, string>;
  /** 标记某厂商正在执行某动作。 */
  markBusy: (id: string, kind: string) => void;
  /** 清除某厂商的忙碌标记。 */
  clearBusy: (id: string) => void;
}

/** 目录装载 hook 的返回值。 */
interface CatalogLoad {
  /** 厂商预设清单。 */
  providers: ProviderPreset[];
  /** 已保存（打码）的 Key。 */
  maskedKeys: Record<string, string>;
  /** 目录装载态。 */
  catalogStatus: CatalogStatus;
  /** 目录读取失败原因。 */
  catalogError: string;
  /** 重新拉厂商目录与打码 Key。 */
  reloadProviders: () => void;
}

/**
 * 拉厂商目录与打码 Key（含竞态防护）。
 * @param api 服务端客户端
 * @param tab 当前设置页
 * @returns 目录数据与重试入口
 */
function useCatalogLoad(api: AppContextValue['api'], tab: SettingsTabKey): CatalogLoad {
  const [providers, setProviders] = React.useState<ProviderPreset[]>([]);
  const [maskedKeys, setMaskedKeys] = React.useState<Record<string, string>>({});
  const [catalogStatus, setCatalogStatus] = React.useState<CatalogStatus>('idle');
  const [catalogError, setCatalogError] = React.useState('');
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

  return { providers, maskedKeys, catalogStatus, catalogError, reloadProviders };
}

/**
 * 忙碌标记（纯 UI 状态）。
 * @returns 标记状态与动作
 */
function useProviderBusy(): BusyControls {
  const [busyById, setBusyById] = React.useState<Record<string, string>>({});

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

  return { busyById, markBusy, clearBusy };
}

/** 模型手选状态（用户点下拉选的模型，优先于生效模型）。 */
interface ModelSelection {
  /** 用户手选的模型：厂商 id → 模型名。 */
  modelSel: Record<string, string>;
  /** 手选某厂商的模型。 */
  setModelChoice: (id: string, value: string) => void;
}

/**
 * 模型手选状态。
 * @returns 手选记录与写入动作
 */
function useModelSelection(): ModelSelection {
  const [modelSel, setModelSel] = React.useState<Record<string, string>>({});
  const setModelChoice = (id: string, value: string): void => {
    setModelSel((prev) => ({ ...prev, [id]: value }));
  };
  return { modelSel, setModelChoice };
}

/** Key 草稿 hook 的入参。 */
interface ProviderDraftOptions {
  /** 服务端客户端。 */
  api: AppContextValue['api'];
  /** 提示通道。 */
  toast: AppContextValue['toast'];
  /** 已保存（打码）的 Key。 */
  maskedKeys: Record<string, string>;
  /** 重新拉目录与打码 Key。 */
  reloadProviders: () => void;
  /** 厂商目录刷新。 */
  refreshModelCatalog: AppContextValue['refreshModelCatalog'];
  /** 标记忙碌。 */
  markBusy: (id: string, kind: string) => void;
  /** 清除忙碌。 */
  clearBusy: (id: string) => void;
}

/** Key 草稿 hook 的返回值。 */
interface ProviderDrafts {
  /** Key 输入草稿。 */
  drafts: Record<string, string>;
  /** 修改某厂商的草稿。 */
  setDraft: (id: string, value: string) => void;
  /** 保存某厂商 Key。 */
  saveKey: (preset: ProviderPreset) => Promise<void>;
}

/**
 * Key 草稿与保存。
 * @param options 依赖与忙碌控制
 * @returns 草稿状态与保存动作
 */
function useProviderDrafts(options: ProviderDraftOptions): ProviderDrafts {
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});

  const setDraft = (id: string, value: string): void => {
    setDrafts((prev) => ({ ...prev, [id]: value }));
  };

  /** 保存某厂商 Key。 */
  const saveKey = async (preset: ProviderPreset): Promise<void> => {
    const key = (drafts[preset.id] ?? '').trim();
    if (key === '') {
      if (options.maskedKeys[preset.id] === undefined) {
        options.toast(t('请输入 API Key'), 'err');
        return;
      }
      options.toast(t('{name} Key 未修改（输入新值才会覆盖）', { name: preset.label }), 'info');
      return;
    }
    options.markBusy(preset.id, 'key');
    try {
      await options.api.updateConfig({ setProviderKey: { vendor: preset.id, key } });
      setDrafts((prev) => ({ ...prev, [preset.id]: '' }));
      options.toast(t('{name} Key 已保存（服务端打码存储）', { name: preset.label }), 'ok');
      options.reloadProviders();
      options.refreshModelCatalog?.();
    } catch (e) {
      options.toast(t('保存失败：{msg}', { msg: (e as Error).message }), 'err');
    } finally {
      options.clearBusy(preset.id);
    }
  };

  return { drafts, setDraft, saveKey };
}

/** 连通检测 hook 的入参。 */
interface ProviderProbeOptions {
  /** 服务端客户端。 */
  api: AppContextValue['api'];
  /** 提示通道。 */
  toast: AppContextValue['toast'];
  /** 厂商目录刷新。 */
  refreshModelCatalog: AppContextValue['refreshModelCatalog'];
  /** 当前服务端配置。 */
  cfg: Config | null;
  /** 手选模型的写入动作（检测成功后把选中项落到实测清单里）。 */
  setModelChoice: (id: string, value: string) => void;
  /** 标记忙碌。 */
  markBusy: (id: string, kind: string) => void;
  /** 清除忙碌。 */
  clearBusy: (id: string) => void;
}

/** 连通检测 hook 的返回值。 */
interface ProviderProbes {
  /** 检测结果：厂商 id → 结果。 */
  probes: Record<string, ProviderProbeResult>;
  /** 连通检测。 */
  probe: (preset: ProviderPreset) => Promise<void>;
}

/**
 * 连通检测：真实请求厂商端点，拿回实测模型清单。
 * @param options 依赖与忙碌控制
 * @returns 检测结果与检测动作
 */
function useProviderProbes(options: ProviderProbeOptions): ProviderProbes {
  const [probes, setProbes] = React.useState<Record<string, ProviderProbeResult>>({});

  /** 连通检测：真实请求厂商端点，拿回实测模型清单。 */
  const probe = async (preset: ProviderPreset): Promise<void> => {
    options.markBusy(preset.id, 'probe');
    try {
      const result = (await options.api.probeModels(preset.id)).providers[0];
      if (result === undefined) {
        options.toast(t('检测失败：厂商未返回结果'), 'err');
        return;
      }
      setProbes((prev) => ({ ...prev, [preset.id]: result }));
      if (result.ok) {
        options.toast(
          t('{name} 连通（{count} 个模型，来源 {source}）', {
            name: preset.label,
            count: result.models.length,
            source: result.source,
          }),
          'ok',
        );
        const keep = result.models.includes(options.cfg?.model ?? '')
          ? (options.cfg?.model as string)
          : result.models[0];
        options.setModelChoice(preset.id, keep ?? preset.defaultModel);
        options.refreshModelCatalog?.();
      } else {
        options.toast(t('{name} 不可用：{msg}', { name: preset.label, msg: result.error ?? t('未知原因') }), 'err');
      }
    } catch (e) {
      options.toast(t('检测失败：{msg}', { msg: (e as Error).message }), 'err');
    } finally {
      options.clearBusy(preset.id);
    }
  };

  return { probes, probe };
}

/** 启用厂商 hook 的入参。 */
interface ProviderEnableOptions {
  /** 服务端客户端。 */
  api: AppContextValue['api'];
  /** 提示通道。 */
  toast: AppContextValue['toast'];
  /** 厂商目录刷新。 */
  refreshModelCatalog: AppContextValue['refreshModelCatalog'];
  /** 当前服务端配置。 */
  cfg: Config | null;
  /** 检测结果（启用时据此取候选模型）。 */
  probes: Record<string, ProviderProbeResult>;
  /** 手选模型。 */
  modelSel: Record<string, string>;
  /** 重新拉目录与打码 Key。 */
  reloadProviders: () => void;
  /** 重拉设置快照。 */
  onReloadSettings: () => Promise<void>;
  /** 标记忙碌。 */
  markBusy: (id: string, kind: string) => void;
  /** 清除忙碌。 */
  clearBusy: (id: string) => void;
}

/**
 * 启用厂商：写入运行时配置，下一条消息即生效。
 * @param options 依赖与忙碌控制
 * @returns 启用动作
 */
function useProviderEnable(options: ProviderEnableOptions): {
  enable: (preset: ProviderPreset) => Promise<void>;
} {
  /** 启用厂商：写入运行时配置，下一条消息即生效。 */
  const enable = async (preset: ProviderPreset): Promise<void> => {
    const models = options.probes[preset.id]?.models ?? [];
    const model = selectedModelFor(preset, models, options.modelSel, options.cfg?.model ?? '');
    if (model === undefined) {
      options.toast(t('没有可用模型，请先检测'), 'err');
      return;
    }
    options.markBusy(preset.id, 'enable');
    try {
      await options.api.updateConfig({ enableProvider: preset.id, model });
      options.toast(t('{name} 已启用（模型 {model}），下一条消息即生效', { name: preset.label, model }), 'ok');
      options.reloadProviders();
      await options.onReloadSettings();
      options.refreshModelCatalog?.();
    } catch (e) {
      options.toast(t('启用失败：{msg}', { msg: (e as Error).message }), 'err');
    } finally {
      options.clearBusy(preset.id);
    }
  };

  return { enable };
}

/**
 * 模型页的厂商目录状态与全部动作。
 * @param options 依赖（api / toast / 当前页 / 配置 / 重拉回调）
 * @returns 目录状态与动作
 */
export function useProviderCatalog(options: ProviderCatalogOptions): ProviderCatalogState {
  const load = useCatalogLoad(options.api, options.tab);
  const busy = useProviderBusy();
  const selection = useModelSelection();
  const drafts = useProviderDrafts({
    api: options.api,
    toast: options.toast,
    maskedKeys: load.maskedKeys,
    reloadProviders: load.reloadProviders,
    refreshModelCatalog: options.refreshModelCatalog,
    markBusy: busy.markBusy,
    clearBusy: busy.clearBusy,
  });
  const probes = useProviderProbes({
    api: options.api,
    toast: options.toast,
    refreshModelCatalog: options.refreshModelCatalog,
    cfg: options.cfg,
    setModelChoice: selection.setModelChoice,
    markBusy: busy.markBusy,
    clearBusy: busy.clearBusy,
  });
  const enabled = useProviderEnable({
    api: options.api,
    toast: options.toast,
    refreshModelCatalog: options.refreshModelCatalog,
    cfg: options.cfg,
    probes: probes.probes,
    modelSel: selection.modelSel,
    reloadProviders: load.reloadProviders,
    onReloadSettings: options.onReloadSettings,
    markBusy: busy.markBusy,
    clearBusy: busy.clearBusy,
  });
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const setExpandedOpen = (id: string, open: boolean): void => {
    setExpanded((prev) => ({ ...prev, [id]: open }));
  };

  return {
    providers: load.providers,
    maskedKeys: load.maskedKeys,
    drafts: drafts.drafts,
    probes: probes.probes,
    modelSel: selection.modelSel,
    catalogStatus: load.catalogStatus,
    catalogError: load.catalogError,
    busyById: busy.busyById,
    expanded,
    reloadProviders: load.reloadProviders,
    setExpandedOpen,
    setDraft: drafts.setDraft,
    setModelChoice: selection.setModelChoice,
    saveKey: drafts.saveKey,
    probe: probes.probe,
    enable: enabled.enable,
  };
}
