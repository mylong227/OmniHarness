/**
 * 进程内缓存**命中率聚合器**（补齐「有缓存、无度量」这一最大观测缺口）。
 *
 * ## 为什么单独成类
 *
 * 本仓有 20 处缓存，而 2026-10-02 盘点实测：**只有 prompt cache 一处**有端到端度量
 * （`cacheHitRateWatch`），其余——包括最热的语料索引、语义索引、repo-map memo——**零命中率观测**。
 * 结果是「命中率到底是 5% 还是 95% 无人知道」，任何针对缓存的调优都无法判定是否真的有效。
 *
 * 本类把「命名缓存 → 命中/未命中计数 → 命中率」收成一处**纯聚合**，由各缓存通过构造注入的
 * `onSample` 回调上报。刻意的设计取舍：
 *
 *  1. **推模式 + 回调注入**：缓存类只依赖 `(hit: boolean) => void` 这个函数类型，
 *     不知道聚合器的存在 ⇒ 零反向依赖、缓存可独立单测、不接聚合器时行为完全不变。
 *  2. **不内置全局单例**：实例由组合根持有并显式下发（本仓铁律：减少 static、杜绝隐式单例）。
 *  3. **只观测不阻断**：命中率低只体现在快照里，绝不抛错、绝不改变业务结果——与
 *     `cacheHitRateWatch` 的「只告警不阻断」同口径。
 *  4. **无样本时命中率记 0 并同时给出 `samples: 0`**：把「没被调用」与「命中率为 0」区分开，
 *     否则空缓存会被误读成「缓存完全失效」——这正是本仓反复治的「假信号」。
 */

/** 单个命名缓存的命中率样本。 */
export interface CacheHitStats {
  /** 命中次数。 */
  readonly hits: number;
  /** 未命中次数。 */
  readonly misses: number;
  /** 样本总数（hits + misses）；为 0 表示该类缓存从未被调用。 */
  readonly samples: number;
  /** 命中率（0–1）；无样本时为 0，判读前**必须**先看 `samples`。 */
  readonly hitRate: number;
}

/** 内部累加槽。 */
interface Counter {
  hits: number;
  misses: number;
}

/**
 * 命名缓存的命中率聚合器（进程内、无第三方依赖、非全局单例）。
 */
export class CacheHitRateCollector {
  /** 缓存名 -> 累加槽。 */
  private readonly counters = new Map<string, Counter>();

  /**
   * 上报一次缓存查询的命中结果。
   * @param name 缓存名（建议用类名，便于与代码对账）。
   * @param hit 本次是否命中。
   * @returns 无返回值。
   */
  public record(name: string, hit: boolean): void {
    const slot = this.counters.get(name) ?? { hits: 0, misses: 0 };
    if (hit) {
      slot.hits += 1;
    } else {
      slot.misses += 1;
    }
    this.counters.set(name, slot);
  }

  /**
   * 快照：按缓存名给出命中/未命中/样本数/命中率。
   * @returns 缓存名到样本的对象（按名排序，便于稳定比对）。
   */
  public snapshot(): Record<string, CacheHitStats> {
    const out: Record<string, CacheHitStats> = {};
    const names = [...this.counters.keys()].sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const slot = this.counters.get(name);
      if (slot === undefined) continue;
      const samples = slot.hits + slot.misses;
      out[name] = {
        hits: slot.hits,
        misses: slot.misses,
        samples,
        hitRate: samples === 0 ? 0 : slot.hits / samples,
      };
    }
    return out;
  }

  /**
   * 清空全部计数（测试与「按会话统计」场景用）。
   * @returns 无返回值。
   */
  public reset(): void {
    this.counters.clear();
  }
}
