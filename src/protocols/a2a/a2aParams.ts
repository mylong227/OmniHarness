/**
 * A2A JSON-RPC 参数读取器（纯函数集合）。
 *
 * 从 `A2aV1Methods` 抽出的原因有两个，都是可证实的：
 * - **体量门禁**：`A2aV1Methods` 在被认证/分页判据撑大后越过「上帝类」阈值；
 *   参数解析本就不是协议语义，混在一起会让该类既做状态机又做类型校验。
 * - **复用与 fail-closed 口径统一**：`recordOf` / `firstString` 这类「非法输入归一为空」
 *   的判定必须只有一处实现，否则不同方法对缺参/错型的行为会漂移。
 *
 * 所有方法对非法输入**不抛错**（归一到空对象 / undefined）；需要报 `-32602` 的地方由调用方
 * 显式判定——「归一」与「拒绝」是两层，不允许在这里静默吞掉。
 */
import { A2A_ERROR_INVALID } from './a2aProtocol.ts';
import { A2aProtocolError } from './a2aProtocolError.ts';

/** A2A 参数读取器。 */
export class A2aParams {
  /**
   * 归一为普通对象（数组 / null / 原始值一律空对象）。
   * @param value 待判值。
   * @returns 普通对象。
   */
  public static recordOf(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  /**
   * 取第一个非空字符串（其余类型与空串一律跳过）。
   * @param values 候选值（按优先级）。
   * @returns 首个非空字符串；没有时为 undefined。
   */
  public static firstString(...values: readonly unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
    return undefined;
  }

  /**
   * 归一任务状态过滤值（兼容规范 ProtoJSON 名与 0.x 连字符名）。
   *
   * 本仓线上状态取小写下划线名（`auth_required` 等，见 `A2aTaskState`）；标准客户端可能按规范发
   * `TASK_STATE_AUTH_REQUIRED`，0.x 客户端可能发 `auth-required`——两种都归一，避免「过滤器写对了
   * 但永远返回空列表」这种最难察觉的互操作故障。
   * @param raw 请求里的状态过滤值。
   * @returns 本仓内部状态名。
   */
  public static normalizeState(raw: string): string {
    const bare = raw.toUpperCase().startsWith('TASK_STATE_')
      ? raw.slice('TASK_STATE_'.length)
      : raw;
    return bare.trim().toLowerCase().replace(/-/g, '_');
  }

  /**
   * 从参数取任务 id（`id` 优先，兼容 `taskId`）。
   * @param record 参数对象。
   * @returns 任务 id。
   */
  public static taskIdOf(record: Record<string, unknown>): string {
    const value = record['id'] ?? record['taskId'];
    if (typeof value !== 'string' || value === '') {
      throw new A2aProtocolError('缺少任务 id（id / taskId）', A2A_ERROR_INVALID);
    }
    return value;
  }

  /**
   * 从参数取 push 配置 id（兼容 `pushNotificationConfigId` / `configId`）。
   * @param record 参数对象。
   * @returns 配置 id；未给出为 undefined。
   */
  public static configIdOf(record: Record<string, unknown>): string | undefined {
    const value = record['pushNotificationConfigId'] ?? record['configId'] ?? record['config_id'];
    return typeof value === 'string' && value !== '' ? value : undefined;
  }
}
