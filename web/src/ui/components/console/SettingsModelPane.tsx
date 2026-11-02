// 设置页「模型与厂商」栏：厂商卡片（Key / 检测 / 启用）+ 默认模型与端点。
//
// 2026-11-02 从 `SettingsSurface` 抽出（`check.mjs` 函数体行数铁律：原 `renderModel`
// 一个箭头函数 93 行，且里面还套着 44 行的 map 回调）。展示组件只接收**已经算好的**
// 每厂商状态；折叠判定、目录请求与动作全部留在 `useProviderCatalog`。
// DOM 结构 / class 名 / aria 文案 / i18n 调用与抽出前逐字一致。

import { t } from '../../i18n/i18n.ts';
import type { SettingsModel } from '../../models/SettingsModel.ts';
import { ConsoleCard, ConsoleSettingRow } from './ConsoleUI.tsx';
import { ProviderCard } from '../settings/ProviderCard.tsx';
import { fieldsOf } from './settingsFields.ts';
import {
  isActiveProvider,
  selectedModelFor,
  type CatalogStatus,
  type ProviderCatalogState,
} from './useProviderCatalog.ts';
import type { Config, ProviderPreset, ProviderProbeResult } from '../../../types/models.ts';

/** 目录提示条的入参。 */
interface CatalogNoticeProps {
  /** 目录装载态。 */
  status: CatalogStatus;
  /** 读取失败原因。 */
  error: string;
  /** 厂商清单是否为空（只有空清单才显示「读取中 / 目录为空」）。 */
  empty: boolean;
  /** 重试回调。 */
  onRetry: () => void;
}

/**
 * 目录提示条：失败原因 + 重试 / 目录为空 / 读取中。
 * @param props 组件入参
 * @returns 提示条；无需提示时为 null
 */
function CatalogNotice(props: CatalogNoticeProps): ReactElement | null {
  if (props.status === 'error') {
    return (
      <div className="sp-load-error" role="alert">
        <span>{t('读取厂商目录失败：{msg}', { msg: props.error })}</span>
        <button className="csl-btn" type="button" onClick={props.onRetry}>
          {t('重试')}
        </button>
      </div>
    );
  }
  if (!props.empty) return null;
  if (props.status === 'ready') {
    return (
      <div className="sp-load-error" role="alert">
        <span>{t('厂商目录为空：defaults/providers.json 可能缺失或不可读。')}</span>
        <button className="csl-btn" type="button" onClick={props.onRetry}>
          {t('重试')}
        </button>
      </div>
    );
  }
  return <p className="csl-empty">{t('读取厂商目录…')}</p>;
}

/** 单个厂商折叠条的入参。 */
interface ProviderEntryProps {
  /** 厂商预设。 */
  preset: ProviderPreset;
  /** 是否展开。 */
  isOpen: boolean;
  /** 是否为当前生效厂商。 */
  active: boolean;
  /** 已保存（打码）的 Key；未配置为 undefined。 */
  maskedKey?: string | undefined;
  /** 该厂商的检测结果。 */
  probe?: ProviderProbeResult | undefined;
  /** Key 输入草稿。 */
  draft: string;
  /** 形如 `<id>:<action>` 的忙碌标记；空串表示空闲。 */
  busy: string;
  /** 卡片内当前选中的模型。 */
  selectedModel?: string | undefined;
  /** 展开 / 折叠。 */
  onToggle: () => void;
  /** Key 草稿变更。 */
  onDraft: (value: string) => void;
  /** 模型下拉变更。 */
  onModelPick: (value: string) => void;
  /** 保存 Key。 */
  onSaveKey: () => void;
  /** 连通检测。 */
  onProbe: () => void;
  /** 启用该厂商。 */
  onEnable: () => void;
}

/**
 * 单个厂商折叠条：标题行（展开箭头 / 名称 / 已配置 / 当前 / 端点）+ 展开后的 Key 卡片。
 * @param props 组件入参
 * @returns 厂商折叠条节点
 */
function ProviderEntry(props: ProviderEntryProps): ReactElement {
  const { preset, isOpen } = props;
  return (
    <div className="sp-card-wrap csl-provider">
      <button
        className="csl-provider-head"
        type="button"
        aria-expanded={isOpen ? 'true' : 'false'}
        onClick={props.onToggle}
      >
        <span className="csl-caret" aria-hidden="true">
          {isOpen ? '▾' : '▸'}
        </span>
        <span className="csl-provider-name">{preset.label}</span>
        {props.maskedKey === undefined ? null : <span className="csl-tag">{t('已配置')}</span>}
        {props.active ? <span className="csl-tag on">{t('当前')}</span> : null}
        <span className="csl-provider-url" title={preset.baseUrl}>
          {preset.baseUrl}
        </span>
      </button>
      {isOpen ? (
        <div className="csl-provider-body">
          <ProviderCard
            preset={preset}
            maskedKey={props.maskedKey}
            probe={props.probe}
            draft={props.draft}
            busy={props.busy}
            active={props.active}
            selectedModel={props.selectedModel}
            onDraft={props.onDraft}
            onModelPick={props.onModelPick}
            onSaveKey={props.onSaveKey}
            onProbe={props.onProbe}
            onEnable={props.onEnable}
          />
        </div>
      ) : null}
    </div>
  );
}

/** 厂商列表的入参。 */
interface ProviderEntriesProps {
  /** 目录状态与动作。 */
  catalog: ProviderCatalogState;
  /** 当前服务端配置（用于判断生效厂商 / 生效模型）。 */
  cfg: Config | null;
}

/**
 * 厂商列表：按目录顺序渲染折叠条，并按「生效 / 已配置 / 已检测」决定默认展开。
 * @param props 组件入参
 * @returns 厂商折叠条列表
 */
function ProviderEntries(props: ProviderEntriesProps): ReactElement {
  const { catalog, cfg } = props;
  const activeAdapter = (cfg?.modelAdapter as string) ?? '';
  const activeBaseUrl = (cfg?.baseUrl as string) ?? '';
  const activeModel = cfg?.model ?? '';
  return (
    <>
      {catalog.providers.map((preset) => {
        const active = isActiveProvider(preset, activeAdapter, activeBaseUrl);
        const auto =
          active ||
          catalog.maskedKeys[preset.id] !== undefined ||
          catalog.probes[preset.id] !== undefined;
        const isOpen = catalog.expanded[preset.id] ?? auto;
        return (
          <ProviderEntry
            key={preset.id}
            preset={preset}
            isOpen={isOpen}
            active={active}
            maskedKey={catalog.maskedKeys[preset.id]}
            probe={catalog.probes[preset.id]}
            draft={catalog.drafts[preset.id] ?? ''}
            busy={catalog.busyById[preset.id] ?? ''}
            selectedModel={selectedModelFor(
              preset,
              catalog.probes[preset.id]?.models ?? [],
              catalog.modelSel,
              activeModel,
            )}
            onToggle={() => catalog.setExpandedOpen(preset.id, !isOpen)}
            onDraft={(value) => catalog.setDraft(preset.id, value)}
            onModelPick={(value) => catalog.setModelChoice(preset.id, value)}
            onSaveKey={() => void catalog.saveKey(preset)}
            onProbe={() => void catalog.probe(preset)}
            onEnable={() => void catalog.enable(preset)}
          />
        );
      })}
    </>
  );
}

/** 厂商接入卡的入参。 */
interface ProviderCatalogCardProps {
  /** 目录状态与动作。 */
  catalog: ProviderCatalogState;
  /** 当前服务端配置。 */
  cfg: Config | null;
}

/**
 * 「厂商接入」卡：标题 / 已配置计数 / 刷新按钮 + 提示条 + 厂商列表。
 * @param props 组件入参
 * @returns 厂商接入卡
 */
function ProviderCatalogCard(props: ProviderCatalogCardProps): ReactElement {
  const { catalog } = props;
  const configured = catalog.providers.filter((preset) => catalog.maskedKeys[preset.id] !== undefined).length;
  return (
    <ConsoleCard
      title={t('厂商接入')}
      meta={
        catalog.providers.length === 0
          ? undefined
          : t('{done}/{total} 已配置 Key', { done: configured, total: catalog.providers.length })
      }
      description={t('保存 Key → 检测（真实请求厂商端点）→ 启用。凭据由服务端打码存储，界面不回显原文。')}
      actions={
        <button className="csl-btn" type="button" onClick={catalog.reloadProviders}>
          {t('刷新')}
        </button>
      }
    >
      <CatalogNotice
        status={catalog.catalogStatus}
        error={catalog.catalogError}
        empty={catalog.providers.length === 0}
        onRetry={catalog.reloadProviders}
      />
      <ProviderEntries catalog={catalog} cfg={props.cfg} />
    </ConsoleCard>
  );
}

/** 「模型与厂商」栏的入参（只包含这一栏真正用到的字段）。 */
export interface SettingsModelPaneProps {
  /** 厂商目录状态与动作。 */
  catalog: ProviderCatalogState;
  /** 当前服务端配置（用于判断生效厂商 / 生效模型 / 工作区展示）。 */
  cfg: Config | null;
  /** 设置模型（字段行读写通道）。 */
  settings: SettingsModel;
}

/**
 * 「模型与厂商」栏：厂商接入 + 默认模型与端点。
 * @param props 组件入参
 * @returns 模型页节点
 */
export function SettingsModelPane(props: SettingsModelPaneProps): ReactElement {
  return (
    <>
      <ProviderCatalogCard catalog={props.catalog} cfg={props.cfg} />
      <ConsoleCard
        title={t('默认模型与端点')}
        description={t('默认模型用于新会话；自定义端点留空即回落厂商默认端点。')}
      >
        {fieldsOf('model').map((field) => (
          <ConsoleSettingRow key={String(field.key)} field={field} model={props.settings} />
        ))}
      </ConsoleCard>
    </>
  );
}
