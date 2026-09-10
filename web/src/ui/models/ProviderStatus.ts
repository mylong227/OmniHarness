// 厂商状态判定：把「探测结果 / 是否保存过 Key / 当前配置」折算成一行状态文案与状态点颜色。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。

import type { ProviderPreset, ProviderProbeResult } from '../../types/models.js';

/** 厂商状态快照。 */
export interface ProviderStatus {
  /** 状态点颜色（CSS 颜色字面量）。 */
  dot: string;
  /** 状态文案。 */
  text: string;
  /** 是否实测可用（仅探测通过才为 true）。 */
  ok: boolean;
}

/** 状态点配色（与仓库既有 UI 语义一致：绿=可用 红=不可用 黄=已保存未实测 灰=未配置）。 */
const COLOR_OK = '#3fb950';
const COLOR_ERR = '#f85149';
const COLOR_SAVED = '#d29922';
const COLOR_IDLE = '#8b949e';

/** 厂商状态解析器。 */
export class ProviderStatusResolver {
  /**
   * 优先级：探测结果 > 已保存 Key > 默认（按需 Key 与否）。
   * 探测存在时以实测为准——「保存过 Key」不等于「能连通」。
   */
  public static resolve(
    p: ProviderPreset,
    maskedKey: string | undefined,
    probe: ProviderProbeResult | undefined,
  ): ProviderStatus {
    if (probe !== undefined) {
      if (probe.ok) {
        return { dot: COLOR_OK, text: `可用 · ${probe.models.length} 个模型`, ok: true };
      }
      return {
        dot: COLOR_ERR,
        text: probe.configured ? `不可用 · ${probe.error ?? ''}` : '未配置 Key',
        ok: false,
      };
    }
    if (maskedKey !== undefined) {
      return { dot: COLOR_SAVED, text: `已保存 ${maskedKey}（未实测）`, ok: false };
    }
    return { dot: COLOR_IDLE, text: p.needsKey ? '未配置 Key' : '免 Key', ok: false };
  }
}
