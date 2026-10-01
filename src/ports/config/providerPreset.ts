import type { ProviderPresetConfig } from './providerPresetConfig.js';

/**
 * 厂商预设（运行时视图）：与 `defaults/providers.json` 记录、`providerPresets` 配置段同形。
 *
 * 已从 `config/providerPresets.ts` 外迁到 ports/config：原文件退化为纯再导出桶，调用点零改动。
 */
export type ProviderPreset = ProviderPresetConfig;
