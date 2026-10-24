import { AgUiJsonPatch } from './aguiJsonPatch.ts';
import type { AgUiEvent } from './aguiProtocol.ts';

/**
 * 会话状态 → AG-UI 状态事件（首个变化发 STATE_SNAPSHOT，后续发 STATE_DELTA）。
 *
 * 只在**状态确实变化**时产事件：补丁为空（值相同）时返回空数组，
 * 避免给前端发空 delta（AG-UI 客户端会把它当成一次无意义的状态同步）。
 */
export class AgUiStateMapper {
  /** JSON Patch 生成器（纯计算，无状态）。 */
  private readonly patch: AgUiJsonPatch;
  /** 当前已同步给前端的完整状态。 */
  private state: Readonly<Record<string, unknown>> = {};
  /** 是否已发过首个 STATE_SNAPSHOT。 */
  private initialized = false;

  /**
   * @param patch JSON Patch 生成器。
   */
  public constructor(patch: AgUiJsonPatch) {
    this.patch = patch;
  }

  /**
   * 更新单个状态键（`todo` / `plan` 事件走这里）。
   * @param key 状态键。
   * @param value 新的状态值；`undefined` 表示删除该键。
   * @returns STATE_SNAPSHOT / STATE_DELTA；无变化时为空数组。
   */
  public update(key: string, value: unknown): readonly AgUiEvent[] {
    const next: Record<string, unknown> = { ...this.state };
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
    return this.commit(next);
  }

  /**
   * 以整份状态替换当前状态（调用方明确知道某个键被清除时使用）。
   * @param next 完整的新状态（值为 `undefined` 的键视为不存在）。
   * @returns STATE_SNAPSHOT / STATE_DELTA；无变化时为空数组。
   */
  public replace(next: Readonly<Record<string, unknown>>): readonly AgUiEvent[] {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
      if (value !== undefined) {
        normalized[key] = value;
      }
    }
    return this.commit(normalized);
  }

  /**
   * 比较并提交新状态，按需生成快照或补丁。
   * @param next 新状态。
   * @returns AG-UI 状态事件；无变化时为空数组。
   */
  private commit(next: Readonly<Record<string, unknown>>): readonly AgUiEvent[] {
    // 先拷贝再 diff：补丁里的 value 与已同步基线因此不引用调用方对象，
    // 调用方事后原地修改事件负载不会污染已发出的 delta / snapshot。
    const stored = this.clone(next);
    const delta = this.patch.diff(this.state, stored);
    if (delta.length === 0) {
      return [];
    }
    const first = !this.initialized;
    this.state = stored;
    this.initialized = true;
    const timestamp = Date.now();
    if (first) {
      return [{ type: 'STATE_SNAPSHOT', snapshot: stored, timestamp }];
    }
    return [{ type: 'STATE_DELTA', delta, timestamp }];
  }

  /**
   * 深拷贝状态，避免调用方后续原地修改污染已同步的基线。
   * @param value 待拷贝值。
   * @returns 拷贝结果；无法结构化克隆时退回原引用。
   */
  private clone<T>(value: T): T {
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
  }
}
