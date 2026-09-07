import type { SpillHandle } from './spill.js';

/**
 * 拓扑环包（燧-4 Vortex-Ring Packet）：把一段内容封成拓扑孤子而非 token 序列。
 * 传输时只携带紧凑 token（不含原文，不扩散、不污染上下文），到目标处解环还原。
 * 拓扑荷（环绕数）+ 校验和封环时固化，解环校验一致才还原——identity 在传播中守恒。
 */
export interface VortexRing {
  /** 环包 ID（绑定外溢句柄）。 */
  readonly ringId: string;
  /** 拓扑荷（环绕数）：封环时固化，解环时校验，守恒即 identity 不变。 */
  readonly winding: number;
  /** 内容 SHA256 校验和（前 16 位），封环时固化，解环重算比对。 */
  readonly checksum: string;
  /** 外溢句柄（完整内容存于 Spill 后端）。 */
  readonly spill: SpillHandle;
  /** 紧凑传输 token：仅 `ringId|winding|checksum`，长度恒定、不含原文。 */
  readonly token: string;
}

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
