/**
 * 兼容门面（用户指令，2026-09-22 第二轮）：厂商目录的**唯一来源**已下沉到配置层
 * `config/providerPresets.ts`，其数据来自随包发布的 `defaults/providers.json`。
 *
 * 保留本模块的理由：既有调用点（`modelCatalogService` / `serverConfigStore` / `appServer` /
 * 单测）此前经本路径导入，门面转发可让它们零改动收敛到新来源；`maskKey` 是与目录无关的
 * 凭据打码工具，继续留在这里，避免为一个函数新开一个模块。
 */
import { providerPresets, type ProviderPreset } from '../../config/providerPresets.js';

/**
 * ProviderPresets —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class ProviderPresets {
  /**
   * 按厂商标识查预设（内建目录 + 用户覆盖）。
   * @param id 厂商标识（`providerKeys` 的键）。
   * @param overrides 配置文件 `providerPresets` 段（可缺省；用于让 UI/CLI 认到自建厂商）。
   * @returns 命中的预设；无此厂商时 undefined。
   */
  public static providerPresetOf(
    id: string,
    overrides?: readonly ProviderPreset[],
  ): ProviderPreset | undefined {
    return providerPresets.byId(id, overrides);
  }

  /** Key 打码：保留前 3 后 4，中间星号；短 Key 全打码。凭据永不回传 UI。 */
  public static maskKey(key: string): string {
    if (key.length <= 8) return '****';
    return `${key.slice(0, 3)}****${key.slice(-4)}`;
  }
}

export { PROVIDER_PRESETS, providerPresets } from '../../config/providerPresets.js';
export type { ProviderPreset } from '../../config/providerPresets.js';
