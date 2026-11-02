import type { AgUiJsonPatchOperation } from './aguiProtocol.ts';

/**
 * RFC 6902 JSON Patch 最小生成器（只做「两份 JSON 值的差异 → 补丁」）。
 *
 * 粒度约定：
 * - 对象按键递归比较，产生 `add` / `replace` / `remove`；
 * - 数组整体替换（`replace`），避免下标移位导致的补丁顺序陷阱；
 * - 值相等（含嵌套对象/数组深比较）时返回**空数组**，调用方据此不发空 delta。
 *
 * 不实现补丁应用与 `move` / `copy` / `test` 生成：AG-UI 的类型面已覆盖后三者，
 * 但会话状态的真实变化只需增删改三种操作。
 */
export class AgUiJsonPatch {
  /**
   * 计算 `previous → next` 的 RFC 6902 补丁。
   * @param previous 变更前的 JSON 值。
   * @param next 变更后的 JSON 值。
   * @returns 补丁操作数组；没有任何变化时为空数组。
   */
  public diff(previous: unknown, next: unknown): readonly AgUiJsonPatchOperation[] {
    return this.walk('', previous, next);
  }

  /**
   * 递归比较任意 JSON 值。
   * @param path 当前值对应的 JSON Pointer。
   * @param previous 变更前的值。
   * @param next 变更后的值。
   * @returns 该路径下的补丁操作。
   */
  private walk(path: string, previous: unknown, next: unknown): readonly AgUiJsonPatchOperation[] {
    if (this.equals(previous, next)) {
      return [];
    }
    if (this.isRecord(previous) && this.isRecord(next)) {
      return this.objectOperations(path, previous, next);
    }
    return [{ op: 'replace', path, value: next }];
  }

  /**
   * 比较两个普通对象的键集合。
   * @param path 父对象对应的 JSON Pointer。
   * @param previous 变更前的对象。
   * @param next 变更后的对象。
   * @returns 按「新增 → 递归 → 删除」顺序生成的补丁。
   */
  private objectOperations(
    path: string,
    previous: Readonly<Record<string, unknown>>,
    next: Readonly<Record<string, unknown>>,
  ): readonly AgUiJsonPatchOperation[] {
    const operations: AgUiJsonPatchOperation[] = [];
    const keys = new Set<string>([...Object.keys(previous), ...Object.keys(next)]);
    for (const key of keys) {
      const child = AgUiJsonPatch.pointer(path, key);
      const hadValue = this.has(previous, key);
      const hasValue = this.has(next, key);
      if (!hadValue && !hasValue) {
        continue;
      }
      if (!hadValue) {
        operations.push({ op: 'add', path: child, value: next[key] });
        continue;
      }
      if (!hasValue) {
        operations.push({ op: 'remove', path: child });
        continue;
      }
      operations.push(...this.walk(child, previous[key], next[key]));
    }
    return operations;
  }

  /**
   * 判断对象是否带某个**有效**键（`undefined` 视为不存在，便于表达删除）。
   * @param record 普通对象。
   * @param key 键名。
   * @returns 自有属性且值不为 undefined 时为 true。
   */
  private has(record: Readonly<Record<string, unknown>>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined;
  }

  /**
   * 判断是否为普通对象（排除 null 与数组）。
   * @param value 待判定值。
   * @returns 普通对象时为 true。
   */
  private isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * JSON 值深比较（对象按键、数组按序）。
   * @param left 左值。
   * @param right 右值。
   * @returns 结构相等时为 true。
   */
  private equals(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
      return true;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) {
        return false;
      }
      for (let index = 0; index < left.length; index += 1) {
        if (!this.equals(left[index], right[index])) {
          return false;
        }
      }
      return true;
    }
    if (this.isRecord(left) && this.isRecord(right)) {
      const leftKeys = Object.keys(left);
      if (leftKeys.length !== Object.keys(right).length) {
        return false;
      }
      for (const key of leftKeys) {
        if (!this.has(right, key) || !this.equals(left[key], right[key])) {
          return false;
        }
      }
      return true;
    }
    return false;
  }

  /**
   * 拼接并转义 JSON Pointer（RFC 6901：`~` → `~0`、`/` → `~1`）。
   * @param path 父路径。
   * @param key 键名。
   * @returns 子节点的 JSON Pointer。
   */
  private static pointer(path: string, key: string): string {
    const escaped = key.replace(/~/gu, '~0').replace(/\//gu, '~1');
    return `${path}/${escaped}`;
  }
}
