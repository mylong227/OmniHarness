/**
 * 向量时钟（Vector Clock）：跨机/多副本的**因果顺序**判定。
 *
 * 单机文件系统 + 文件锁已提供线性化点，但多机共享工作区 / 离线副本需要回答
 * 「这两个版本是先后还是并发」——哈希只能回答"是否相同"，不能回答因果。
 *
 * 规则：
 * - `tick(node)` 把本节点计数 +1；
 * - `merge(other)` 逐节点取 max（并发事件的合并）；
 * - `compare`：`before` / `after` / `equal` / `concurrent`；
 * - `concurrent` 是**需要显式合并**的信号，不能靠时间戳猜。
 *
 * @maturity L2 — 真实实现向量时钟的 tick/merge/偏序比较；未做多副本垃圾回收与动态节点集
 * @maturityEvidence tests/unit/vectorClock.test.ts
 */

/** 两个向量时钟的因果关系。 */
export type VectorClockRelation = 'equal' | 'before' | 'after' | 'concurrent';

/** 向量时钟。 */
export class VectorClock {
  /** 节点 → 逻辑计数。 */
  private readonly counters: Map<string, number>;

  /**
   * @param initial 初始计数（可选；非法计数抛错）。
   */
  public constructor(initial: Readonly<Record<string, number>> = {}) {
    this.counters = new Map();
    for (const [node, count] of Object.entries(initial)) {
      VectorClock.requireCount(count, node);
      this.counters.set(node, count);
    }
  }

  /**
   * 本节点计数 +1，返回新时钟（不修改原对象）。
   * @param node 节点 id。
   * @returns 新时钟。
   */
  public tick(node: string): VectorClock {
    if (node === '') throw new Error('node 不能为空');
    return new VectorClock({ ...this.toJSON(), [node]: (this.counters.get(node) ?? 0) + 1 });
  }

  /**
   * 合并另一个时钟（逐节点 max），返回新时钟。
   * @param other 另一个时钟。
   * @returns 新时钟。
   */
  public merge(other: VectorClock): VectorClock {
    const next: Record<string, number> = { ...this.toJSON() };
    for (const [node, count] of other.counters) {
      next[node] = Math.max(next[node] ?? 0, count);
    }
    return new VectorClock(next);
  }

  /**
   * 比较因果顺序。
   * @param other 另一个时钟。
   * @returns equal / before / after / concurrent。
   */
  public compare(other: VectorClock): VectorClockRelation {
    let less = false;
    let greater = false;
    for (const node of this.nodes()) {
      const a = this.counters.get(node) ?? 0;
      const b = other.counters.get(node) ?? 0;
      if (a < b) less = true;
      if (a > b) greater = true;
    }
    for (const node of other.nodes()) {
      const a = this.counters.get(node) ?? 0;
      const b = other.counters.get(node) ?? 0;
      if (a < b) less = true;
      if (a > b) greater = true;
    }
    if (less && greater) return 'concurrent';
    if (less) return 'before';
    if (greater) return 'after';
    return 'equal';
  }

  /**
   * 取某节点计数。
   * @param node 节点 id。
   * @returns 计数（缺省 0）。
   */
  public get(node: string): number {
    return this.counters.get(node) ?? 0;
  }

  /**
   * 全部节点。
   * @returns 节点 id 数组（排序后，保证输出稳定）。
   */
  public nodes(): string[] {
    return [...this.counters.keys()].sort();
  }

  /**
   * 导出普通对象。
   * @returns 节点 → 计数。
   */
  public toJSON(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  /**
   * 从普通对象构造。
   * @param value 节点 → 计数。
   * @returns 向量时钟。
   */
  public static fromJSON(value: unknown): VectorClock {
    if (value === null || typeof value !== 'object') {
      throw new Error('向量时钟必须是对象');
    }
    return new VectorClock(value as Record<string, number>);
  }

  /**
   * 校验计数为非负整数。
   * @param count 计数。
   * @param node 节点 id（错误信息）。
   * @returns 无返回值。
   */
  private static requireCount(count: number, node: string): void {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`向量时钟计数非法（${node}=${String(count)}）：需为非负整数`);
    }
  }
}
