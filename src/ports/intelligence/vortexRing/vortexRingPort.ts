import type { VortexRing } from './vortexRing.js';

/**
 * 燧-4 涡环包端口：解决长程依赖里"信息被沿途稀释/污染"。
 * 封环即固化拓扑守恒量；解环 fail-closed——任何篡改（内容/荷/校验）均拒绝还原。
 */
export interface VortexRingPort {
  readonly name: string;
  /** 封环：内容落 Spill，返回拓扑环包（含固化 winding/checksum/token）。 */
  seal(content: string): Promise<VortexRing>;
  /** 解环：校验拓扑荷与校验和，一致才还原内容；被污染/篡改返回 undefined（fail-closed）。 */
  unseal(ring: VortexRing): Promise<string | undefined>;
}
