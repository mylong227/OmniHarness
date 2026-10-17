// 厂商卡片：设置面板「模型」栏里的一行（一个厂商）。
//
// 从旧 `tabs/ModelProviders.tsx` 提取（2026-10-17 设置面板重构）：
//   · 旧实现把颜色与间距写成**内联 style 常量**（`border: '1px solid var(--border, #30363d)'`、
//     `ACTIVE_TAG: { color: '#3fb950' }`）——内联样式绕过了设计系统，`#3fb950` 这类硬编码色
//     在单色重设计后仍然生效（它是绿色，且不受 token 影响）。提取时全部改为 class。
//   · 旧实现一次渲染**全部**厂商卡片（8 个厂商 ⇒ 面板很长）。现在保留同样的信息，
//     但用可折叠的卡片：默认只展开当前生效厂商与已配置 Key 的厂商，其余折叠成一行。
//
// 单色口径：状态用**字形 + 明度**表达（● 已启用 / ○ 未启用 / ✓ 已保存 Key / ! 检测失败），
// 颜色只做明度差，不引入色相 —— 见 DESIGN_SYSTEM §2.4。

import * as React from 'react';
import { icon } from '../../models/Icon.ts';
import { ProviderStatusResolver } from '../../models/ProviderStatus.ts';
import type { ProviderPreset, ProviderProbeResult } from '../../../types/models.ts';
import { t } from '../../i18n/i18n.ts';

/** ProviderCard 组件的入参。 */
export interface ProviderCardProps {
  /** 厂商预设。 */
  preset: ProviderPreset;
  /** 已保存（打码）的 Key；未配置为 undefined。 */
  maskedKey?: string | undefined;
  /** 该厂商的检测结果。 */
  probe?: ProviderProbeResult | undefined;
  /** Key 输入草稿（仅存在于内存，保存后清空）。 */
  draft: string;
  /** 形如 `<id>:<action>` 的忙碌标记；空串表示空闲。 */
  busy: string;
  /** 是否为当前生效厂商。 */
  active: boolean;
  /** 卡片内当前选中的模型。 */
  selectedModel?: string | undefined;
  /** 草稿变更。 */
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
 * 单个厂商卡片：名称 + 端点 + 状态 + Key + 检测 + 模型选择 + 启用。
 * @param props 组件入参
 * @returns 厂商卡片节点
 */
export function ProviderCard(props: ProviderCardProps): ReactElement {
  const { preset, maskedKey, probe, draft, busy, active, selectedModel } = props;
  const st = ProviderStatusResolver.resolve(preset, maskedKey, probe);
  const models = probe?.models ?? [];
  const hasKey = maskedKey !== undefined;
  const disabled = busy !== '';
  // 检测失败是唯一需要"警示"的状态；其余用中性档（见 §2.4 语义明度阶梯）。
  const failed = probe !== undefined && !probe.ok;
  return (
    <div className={'sp-card' + (active ? ' on' : '')} data-provider={preset.id}>
      <div className="sp-card-head">
        <span className="sp-card-name">
          {icon('package', { size: 13 })}
          {preset.label}
        </span>
        {active ? <span className="sp-tag">{t('● 当前使用')}</span> : null}
        <span className="sp-card-url" title={preset.baseUrl}>
          {preset.baseUrl}
        </span>
      </div>

      <div className="sp-card-state">
        <span className={'sp-dot' + (failed ? ' err' : hasKey ? ' ok' : '')} aria-hidden="true" />
        <span className="sp-card-statetext">{st.text}</span>
      </div>

      <div className="sp-row">
        <input
          type="password"
          className="sp-input"
          aria-label={`${preset.label} API Key`}
          placeholder={hasKey ? t('已保存 {key}，输入新值覆盖', { key: maskedKey }) : t('输入 API Key')}
          value={draft}
          onInput={(e: React.SyntheticEvent) => props.onDraft((e.target as HTMLInputElement).value)}
        />
        <button className="ghost" disabled={disabled} onClick={props.onSaveKey}>
          {t('保存 Key')}
        </button>
        <button className="ghost" disabled={disabled} onClick={props.onProbe}>
          {t('检测')}
        </button>
      </div>

      {probe?.ok === true && models.length > 0 ? (
        <div className="sp-row">
          <select
            className="sp-input"
            aria-label={t('{name} 可用模型', { name: preset.label })}
            value={selectedModel ?? models[0]}
            onChange={(e: React.SyntheticEvent) => props.onModelPick((e.target as HTMLSelectElement).value)}
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button className="ghost" disabled={disabled || !selectedModel} onClick={props.onEnable}>
            {t('启用此厂商')}
          </button>
        </div>
      ) : (
        <div className="sp-hint">
          {failed
            ? t('检测未通过：{msg}（保存有效 Key 后重试）', { msg: probe?.error ?? t('未知原因') })
            : hasKey
              ? t('已保存 Key，点「检测」拉取真实可用模型清单')
              : t('未配置 Key：保存 → 检测 → 启用后才会显示可用模型')}
        </div>
      )}
    </div>
  );
}
