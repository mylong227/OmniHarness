/**
 * 非牛顿固化存储适配器（燧-2 原语实现，零依赖）。
 *
 * 包装任意 {@link KvPort} 后端（内存 / JSON 文件 / SQLite），在不改动 KvPort 接口的前提下，
 * 把「屈服应力 + 冲击冻结」语义叠加到字符串 KV 之上。记录以 JSON 序列化后落盘，
 * 内部 key 加 `oobleck:` 前缀，避免与同后端的其他 KV 用法冲突。
 *
 * 行为（详见 {@link OobleckPort}）：
 * - 液态（rig=0）：`propose` 以 `impact < yieldStress` 反复覆盖，状态松弛。
 * - 越过阈值：`propose` 的 `impact >= yieldStress` 时剪切增稠，提交并永久冻结（rig=1）——**冻结是冲击涌现的，非显式调用**。
 * - 冻结后：任何 `propose` / `delete` 均被拒绝（fail-closed，不可变）。
 */
import type { KvPort } from '../../ports/kv.js';
import type { OobleckPort, OobleckRecord, OobleckWriteResult } from '../../ports/oobleck.js';

const KEY_PREFIX = 'oobleck:';

interface StoredRecord {
  /** 当前值。 */
  value: string;
  /** 0 = 液态（松弛），1 = 已冻结（不可变）。 */
  rig: 0 | 1;
  /** 冻结时间戳；未冻结为 null。 */
  frozenAt: number | null;
}

/** OobleckStore 选项。 */
export interface OobleckStoreOptions {
  /** 屈服应力阈值 τ，默认 0.6。写入冲击越过即冻结。 */
  readonly yieldStress?: number;
}

/** 非牛顿固化存储：提交由冲击涌现，冻结后不可变。 */
export class OobleckStore implements OobleckPort {
  /** 端口名：非牛顿固化存储标识，与 OobleckPort 契约的适配器命名空间一致。 */
  public readonly name = 'oobleck';

  private readonly kv: KvPort;
  private readonly yieldStress: number;

  public constructor(kv: KvPort, options: OobleckStoreOptions = {}) {
    this.kv = kv;
    this.yieldStress = options.yieldStress ?? 0.6;
  }

  /**
   * 以冲击幅度提议写入：已冻结 → 拒绝（accepted=false，reason='frozen'）；
   * `impact ≥ yieldStress` → 提交并永久冻结（reason='yield'，冻结涌现自冲击而非显式调用）；
   * 否则液态覆盖、状态松弛（reason='liquid'）。
   * @param key 逻辑键（落底层 KV 时自动加 `oobleck:` 前缀）。
   * @param value 待写入值。
   * @param impact 本次写入的冲击幅度，与屈服应力阈值比较。
   * @returns 写入结果（是否接受、是否导致冻结、原因）。
   */
  public async propose(key: string, value: string, impact: number): Promise<OobleckWriteResult> {
    const stored = await this.readStored(key);
    if (stored !== undefined && stored.rig >= 1) {
      // 已冻结：不可变，fail-closed 拒绝（不覆盖、不报错、仅拒绝）。
      return { accepted: false, frozen: true, reason: 'frozen' };
    }
    if (impact >= this.yieldStress) {
      // 剪切增稠：提交 + 永久冻结。冻结是冲击越过阈值的涌现结果，而非显式调用。
      await this.kv.set(
        KEY_PREFIX + key,
        JSON.stringify({ value, rig: 1 as const, frozenAt: Date.now() } satisfies StoredRecord),
      );
      return { accepted: true, frozen: true, reason: 'yield' };
    }
    // 液态：覆盖写入，状态松弛（rig 保持 0）。
    await this.kv.set(
      KEY_PREFIX + key,
      JSON.stringify({ value, rig: 0 as const, frozenAt: null } satisfies StoredRecord),
    );
    return { accepted: true, frozen: false, reason: 'liquid' };
  }

  /** 读取记录（含值、冻结态与本实例的屈服应力阈值）；不存在返回 undefined。 */
  public async get(key: string): Promise<OobleckRecord | undefined> {
    const stored = await this.readStored(key);
    if (stored === undefined) {
      return undefined;
    }
    return { value: stored.value, frozen: stored.rig >= 1, yieldStress: this.yieldStress };
  }

  /** 是否已冻结（rig≥1）；键不存在亦为 false。 */
  public async isFrozen(key: string): Promise<boolean> {
    const stored = await this.readStored(key);
    return stored !== undefined && stored.rig >= 1;
  }

  /** 删除：液态下允许并返回底层删除结果；冻结后不可变，fail-closed 拒绝返回 false。 */
  public async delete(key: string): Promise<boolean> {
    const stored = await this.readStored(key);
    if (stored !== undefined && stored.rig >= 1) {
      // 冻结后不可变：删除同样拒绝（fail-closed）。
      return false;
    }
    return this.kv.delete(KEY_PREFIX + key);
  }

  /** 关闭底层 KvPort，释放其后端资源。 */
  public async close(): Promise<void> {
    await this.kv.close();
  }

  /** 读取并解析底层记录；解析失败或缺失返回 undefined。 */
  private async readStored(key: string): Promise<StoredRecord | undefined> {
    const raw = await this.kv.get(KEY_PREFIX + key);
    if (raw === undefined) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as StoredRecord;
      if (typeof parsed.value !== 'string' || (parsed.rig !== 0 && parsed.rig !== 1)) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }
}
