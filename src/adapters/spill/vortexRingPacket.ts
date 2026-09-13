/**
 * @maturity L0 — 打包语义，非拓扑不变量（拓扑荷只是可算代理）
 * @maturityEvidence tests/unit/vortexRing.test.ts
 */
import { createHash } from 'node:crypto';
import type { SpillHandle, SpillPort } from '../../ports/memory/spill.js';
import type { VortexRing, VortexRingPort } from '../../ports/intelligence/vortexRing.js';
import { fnv1a } from '../../util/eigenspectrum.js';

/** 内容校验和（SHA256 前 16 位）。 */
function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 拓扑荷（环绕数）：内容字符序列相邻哈希差分的符号累计。封环时固化，
 * 解环时重算比对——任何单字符篡改都会改变差分序列，从而破坏守恒量。
 * 这是"拓扑孤子守恒"的轻量可计算代理（零依赖、确定性）。
 */
function windingNumber(content: string): number {
  if (content.length === 0) return 0;
  let w = 0;
  let prev = fnv1a(content.charAt(0));
  for (let i = 1; i < content.length; i++) {
    const cur = fnv1a(content.charAt(i));
    const d = cur - prev;
    if (d > 0) w += 1;
    else if (d < 0) w -= 1;
    prev = cur;
  }
  return w;
}

/**
 * 燧-4 涡环包：包装任意 `SpillPort`。封环把内容落 Spill（完整保留），
 * 环包仅携带固化拓扑量 + 紧凑 token；解环校验拓扑荷与校验和，fail-closed 抗污染。
 */
export class VortexRingPacket implements VortexRingPort {
  /** 适配器名称（标识此涡环包实现）。 */
  public readonly name = 'vortex-ring';

  public constructor(private readonly spill: SpillPort) {}

  /**
   * 封环：把内容落 Spill 并固化拓扑荷 + 校验和，返回携带紧凑 token 的涡环。
   * @param content 待封存的明文内容
   * @returns 涡环（含 ringId、拓扑荷、校验和与紧凑 token）
   */
  public async seal(content: string): Promise<VortexRing> {
    const handle = await this.spill.spill(content, 'vortex');
    const winding = windingNumber(content);
    const cs = checksum(content);
    const ringId = `vr_${handle.id}`;
    const token = `${ringId}|${winding}|${cs}`;
    return { ringId, winding, checksum: cs, spill: handle, token };
  }

  /**
   * 解环：重算并校验拓扑荷与校验和（fail-closed），一致则还原明文。
   * @param ring 待解封的涡环
   * @returns 还原的明文；若 Spill 缺失或拓扑荷/校验和不匹配则返回 `undefined`
   */
  public async unseal(ring: VortexRing): Promise<string | undefined> {
    const content = await this.spill.read(ring.spill.id);
    if (content === undefined) return undefined;
    if (windingNumber(content) !== ring.winding) return undefined; // 拓扑荷破坏 → 拒绝
    if (checksum(content) !== ring.checksum) return undefined; // 内容被污染 → 拒绝
    return content;
  }
}
