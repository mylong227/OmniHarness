/**
 * 规范 JSON（canonical JSON）——审计哈希链**唯一的序列化口径**。
 *
 * 为什么必须自己实现（而不是 `JSON.stringify(record)`）：对象键顺序在 JS 里是插入顺序，
 * 同一条记录经不同实现（Node / 浏览器 / 第三方复核工具）构造时会因键序不同而算出不同哈希，
 * 于是"链断裂"变成假警报。规范 JSON 的规则（与 RFC 8785 的子集一致，只覆盖审计用到的
 * JSON 类型）：
 *
 * 1. 对象键按 UTF-16 码元升序排列；
 * 2. 值为 `undefined` 的键**整个省略**（与 `JSON.stringify` 语义一致）；
 * 3. 数组保持顺序；数组里的 `undefined` 写成 `null`；
 * 4. 字符串、数字、布尔、null 直接复用 `JSON.stringify`（保证转义与 `-0`/NaN 语义一致）；
 * 5. 嵌套深度上限 {@link AuditCanonical.MAX_DEPTH}——报告是外部输入，防递归炸栈（fail-closed）。
 *
 * HTML 报告里内嵌的浏览器复核器实现了同一套规则；判据 `auditCanonical.test.ts` 用
 * 逐字节 golden 把两边钉住。
 */
export class AuditCanonical {
  /** 嵌套深度上限：审计记录是扁平结构，超过即视为坏输入（抛错而不是静默截断）。 */
  public static readonly MAX_DEPTH = 64;

  /**
   * 把任意 JSON 值序列化为规范 JSON。
   * @param value 待序列化的值（undefined 视作 null）。
   * @returns 规范 JSON 文本。
   * @throws Error 嵌套超过 {@link AuditCanonical.MAX_DEPTH} 时抛出（防环 / 防炸栈）。
   */
  public static stringify(value: unknown): string {
    const text = AuditCanonical.serialize(value, 0);
    return text ?? 'null';
  }

  /**
   * 递归序列化（内部实现）。
   * @param value 待序列化的值。
   * @param depth 当前深度（根为 0）。
   * @returns 规范 JSON 片段；`undefined` 表示"该值在对象里应被省略"。
   * @throws Error 超过深度上限时抛出。
   */
  private static serialize(value: unknown, depth: number): string | undefined {
    if (depth > AuditCanonical.MAX_DEPTH) {
      throw new Error(`规范 JSON 嵌套超过 ${String(AuditCanonical.MAX_DEPTH)} 层，拒绝序列化`);
    }
    if (value === null) {
      return 'null';
    }
    // `undefined` 在对象里应被省略、在数组里应写 null——交由两个调用点分别处理，
    // 这里返回 undefined 表示"没有可序列化的文本"。
    if (value === undefined) {
      return undefined;
    }
    if (Array.isArray(value)) {
      return AuditCanonical.serializeArray(value, depth);
    }
    if (typeof value === 'object') {
      return AuditCanonical.serializeObject(value, depth);
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
      return JSON.stringify(value);
    }
    // bigint / symbol / function 不属于 JSON 模型：与 JSON.stringify 一致，对象里省略、数组里 null。
    return undefined;
  }

  /**
   * 序列化数组（保持顺序，元素 undefined 写 null）。
   * @param items 数组。
   * @param depth 当前深度。
   * @returns `[a,b]` 形式文本。
   */
  private static serializeArray(items: readonly unknown[], depth: number): string {
    const parts = items.map((item) =>
      item === undefined ? 'null' : (AuditCanonical.serialize(item, depth + 1) ?? 'null'),
    );
    return `[${parts.join(',')}]`;
  }

  /**
   * 序列化对象（键排序、undefined 键省略）。
   * @param record 普通对象。
   * @param depth 当前深度。
   * @returns `{"a":1}` 形式文本。
   */
  private static serializeObject(record: object, depth: number): string {
    const source = record as Readonly<Record<string, unknown>>;
    const keys = Object.keys(source).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const text = AuditCanonical.serialize(source[key], depth + 1);
      if (text === undefined) {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${text}`);
    }
    return `{${parts.join(',')}}`;
  }
}
