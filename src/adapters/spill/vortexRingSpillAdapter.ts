import type { SpillHandle, SpillPort } from '../../ports/spill.js';
import type { VortexRing, VortexRingPort } from '../../ports/vortexRing.js';

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

export { VortexRingPacket } from './vortexRingPacket.js';
