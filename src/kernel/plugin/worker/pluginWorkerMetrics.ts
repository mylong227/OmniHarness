/**
 * Plugin Worker 运行期指标（ADR-0012）。
 *
 * 为什么不挂在 Supervisor 实例上：Supervisor 已有较多字段/方法（上帝类门禁），指标改为
 * **按插件名的进程级注册表**，任何持有插件名的诊断面都能读到，不需要额外实例引用。
 * 指标只做计数，不含参数/输出，避免泄漏插件数据。
 */
export interface PluginWorkerMetricsSnapshot {
  /** 成功激活次数。 */
  readonly activations: number;
  /** 工具调用次数。 */
  readonly calls: number;
  /** 工具调用失败次数。 */
  readonly failures: number;
  /** Worker 崩溃/超时次数。 */
  readonly crashes: number;
}

/** 进程级 Worker 指标注册表。 */
export class PluginWorkerMetrics {
  /** 插件名 → 计数。 */
  private static readonly counters = new Map<string, PluginWorkerMetricsSnapshot>();

  /**
   * 记录一个事件。
   * @param plugin 插件名。
   * @param kind 事件类型。
   * @returns 无返回值。
   */
  public static record(plugin: string, kind: 'activation' | 'call' | 'failure' | 'crash'): void {
    const current = PluginWorkerMetrics.counters.get(plugin) ?? {
      activations: 0,
      calls: 0,
      failures: 0,
      crashes: 0,
    };
    const next: PluginWorkerMetricsSnapshot = {
      activations: current.activations + (kind === 'activation' ? 1 : 0),
      calls: current.calls + (kind === 'call' ? 1 : 0),
      failures: current.failures + (kind === 'failure' ? 1 : 0),
      crashes: current.crashes + (kind === 'crash' ? 1 : 0),
    };
    PluginWorkerMetrics.counters.set(plugin, next);
  }

  /**
   * 读取单个插件指标。
   * @param plugin 插件名。
   * @returns 快照（无记录时全 0）。
   */
  public static snapshot(plugin: string): PluginWorkerMetricsSnapshot {
    return (
      PluginWorkerMetrics.counters.get(plugin) ?? {
        activations: 0,
        calls: 0,
        failures: 0,
        crashes: 0,
      }
    );
  }

  /**
   * 全部插件指标（诊断/doctor 用）。
   * @returns 插件名 → 快照。
   */
  public static all(): Readonly<Record<string, PluginWorkerMetricsSnapshot>> {
    return Object.fromEntries(PluginWorkerMetrics.counters);
  }

  /**
   * 清空注册表（仅测试用）。
   * @returns 无返回值。
   */
  public static reset(): void {
    PluginWorkerMetrics.counters.clear();
  }
}
