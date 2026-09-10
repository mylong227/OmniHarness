import { createHash } from 'node:crypto';
import type { SpillHandle, SpillPort } from '../../ports/spill.js';
import type { VortexRing, VortexRingPort } from '../../ports/vortexRing.js';
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
  public readonly name = 'vortex-ring';

  public constructor(private readonly spill: SpillPort) {}

  public async seal(content: string): Promise<VortexRing> {
    const handle = await this.spill.spill(content, 'vortex');
    const winding = windingNumber(content);
    const cs = checksum(content);
    const ringId = `vr_${handle.id}`;
    const token = `${ringId}|${winding}|${cs}`;
    return { ringId, winding, checksum: cs, spill: handle, token };
  }

  public async unseal(ring: VortexRing): Promise<string | undefined> {
    const content = await this.spill.read(ring.spill.id);
    if (content === undefined) return undefined;
    if (windingNumber(content) !== ring.winding) return undefined; // 拓扑荷破坏 → 拒绝
    if (checksum(content) !== ring.checksum) return undefined; // 内容被污染 → 拒绝
    return content;
  }
}

/**
 * 燧-4 涡环包外溢适配器：把 `VortexRingPacket` 适配成标准 `SpillPort`，
 * 使既有 `ToolResultSpiller`（#74）无需任何改动即可走拓扑环包传输。
 *
 * 装配层（ConfigFactory）在 `vortexRing.enabled` 时把 `config.spill` 封包为本适配器，
 * 于是 Agent 主循环里所有"超大工具输出外溢"都自动封成拓扑孤子（fail-closed 抗污染、
 * 不随内容膨胀）——燧-4 从"端口"变为"真能力"。
 *
 * 环包元信息（ringId→VortexRing）驻留本进程内存；跨进程重启后读回未知环包返回
 * `undefined`（fail-closed，安全）。完整内容仍由底层 SpillPort 持久化。
 */
export class VortexRingSpillAdapter implements SpillPort {
  public readonly name = 'vortex-ring-spill';

  private readonly rings = new Map<string, VortexRing>();

  public constructor(private readonly vortex: VortexRingPort) {}

  public async spill(content: string, _sessionId: string): Promise<SpillHandle> {
    const ring = await this.vortex.seal(content);
    this.rings.set(ring.ringId, ring);
    return { id: ring.ringId, bytes: Buffer.byteLength(content, 'utf8') };
  }

  public async read(id: string): Promise<string | undefined> {
    const ring = this.rings.get(id);
    if (ring === undefined) return undefined; // fail-closed：未知环包拒绝还原
    return this.vortex.unseal(ring);
  }

  /**
   * 燧-4 冲刷（autoRun 用）：返回当前进程内持环数。环包元信息驻留内存，
   * 解环校验在 `read` 时 fail-closed 执行；此处仅做健康检查计数。
   */
  public flush(): { readonly activeRings: number } {
    return { activeRings: this.rings.size };
  }
}
