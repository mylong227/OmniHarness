import type { SpillHandle, SpillPort } from '../../ports/memory/spill.js';
import type { VortexRing, VortexRingPort } from '../../ports/intelligence/vortexRing.js';
import { log } from '../../util/logger.js';

/** 进程内环包元信息的默认保留上限（个）。 */
export const DEFAULT_SPILL_MAX_RINGS = 256;

/** 环包外溢保留选项。 */
export interface VortexRingSpillOptions {
  /**
   * 进程内环包元信息上限（个，默认 {@link DEFAULT_SPILL_MAX_RINGS}）。
   *
   * 为什么必须有上限（审计 §1.7「涡环包无回收」）：`rings` 表每次 `spill` 都插入且**从不移除**，
   * 于是「长跑会话里反复外溢」＝内存单调增长（每个环包还持有内容元信息）。超限后按
   * **最近最少使用**淘汰：`read` 会把命中的环包移到队尾（回读即续命），最旧的先被淘汰。
   * 被淘汰的 id 再读返回 `undefined`（本类既有 fail-closed 语义），并告警一次便于归因。
   * `0` 或负数表示**不淘汰**（保留旧行为）。
   */
  readonly maxRings?: number | undefined;
}

/**
 * 燧-4 涡环包外溢适配器：把 `VortexRingPacket` 适配成标准 `SpillPort`，
 * 使既有 `ToolResultSpiller`（#74）无需任何改动即可走拓扑环包传输。
 *
 * 装配层（ConfigFactory）在 `vortexRing.enabled` 时把 `config.spill` 封包为本适配器，
 * 于是 Agent 主循环里所有"超大工具输出外溢"都自动封成拓扑孤子（fail-closed 抗污染、
 * 不随内容膨胀）——燧-4 从"端口"变为"真能力"。
 *
 * 环包元信息（ringId→VortexRing）驻留本进程内存，**有上限并按 LRU 淘汰**（见
 * {@link VortexRingSpillOptions.maxRings}）；跨进程重启后读回未知环包返回
 * `undefined`（fail-closed，安全）。完整内容仍由底层 SpillPort 持久化。
 */
export class VortexRingSpillAdapter implements SpillPort {
  /** 适配器标识名（SpillPort 注册键，用于诊断）。 */
  public readonly name = 'vortex-ring-spill';

  /** 进程内环包元信息表：ringId → VortexRing（LRU：`read` 命中会移到队尾；超限淘汰队首）。 */
  private readonly rings = new Map<string, VortexRing>();

  /** 环包保留上限（0 = 不淘汰）。 */
  private readonly maxRings: number;

  /**
   * @param vortex 底层燧-4 端口（seal 封包 / unseal 解环由它执行，本适配器只做元信息登记与适配）。
   * @param options 保留策略（可选；缺省取 {@link DEFAULT_SPILL_MAX_RINGS}）。
   */
  public constructor(
    private readonly vortex: VortexRingPort,
    options: VortexRingSpillOptions = {},
  ) {
    this.maxRings = options.maxRings ?? DEFAULT_SPILL_MAX_RINGS;
  }

  /**
   * 把超大内容封成拓扑孤子环包并持久化：seal 后得到 ringId，记进程内元信息后返回句柄。
   *
   * @param content 待外溢的内容文本
   * @param _sessionId 会话标识（当前实现环包不按会话隔离，保留接口位）
   * @returns 外溢句柄（id=ringId，bytes=内容字节数）
   */
  public async spill(content: string, _sessionId: string): Promise<SpillHandle> {
    const ring = await this.vortex.seal(content);
    this.rings.set(ring.ringId, ring);
    this.evictIfNeeded();
    return { id: ring.ringId, bytes: Buffer.byteLength(content, 'utf8') };
  }

  /**
   * 按 ringId 还原外溢内容：未知（或已被淘汰）环包返回 undefined（fail-closed 拒绝还原）。
   *
   * 命中即**续命**：把该环包移到队尾，使 LRU 淘汰与真实使用顺序一致。
   * @param id 环包标识（spill 返回的句柄 id）
   * @returns 还原后的内容文本；未知环包返回 undefined
   */
  public async read(id: string): Promise<string | undefined> {
    const ring = this.rings.get(id);
    if (ring === undefined) return undefined; // fail-closed：未知环包拒绝还原
    this.rings.delete(id);
    this.rings.set(id, ring);
    return this.vortex.unseal(ring);
  }

  /**
   * 燧-4 冲刷（autoRun 用）：返回当前进程内持环数。环包元信息驻留内存，
   * 解环校验在 `read` 时 fail-closed 执行；此处仅做健康检查计数。
   * @returns 当前仍驻留进程内的环包数量。
   */
  public flush(): { readonly activeRings: number } {
    return { activeRings: this.rings.size };
  }

  /**
   * 超限淘汰：按插入顺序（队首＝最久未使用）删除，直到回到上限之内。
   * @returns 无返回值。
   */
  private evictIfNeeded(): void {
    if (this.maxRings <= 0) {
      return;
    }
    while (this.rings.size > this.maxRings) {
      const oldest = this.rings.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.rings.delete(oldest.value);
      log.warn('spill.ring.evicted', { ringId: oldest.value, limit: this.maxRings });
    }
  }
}

export { VortexRingPacket } from './vortexRingPacket.js';
