/**
 * 文本插入操作变换（OT，**insert-only**）。
 *
 * 实时协同里最常见的并发是两端在不同位置插入；成对变换满足：
 *
 * ```text
 * apply(apply(t, a), b') === apply(apply(t, b), a')
 * ```
 *
 * 同一位置插入的平局用**文本字典序**决定先后（两端算出同一顺序）；文本相同视为重复，
 * 后者变成空操作。**边界（诚实登记）**：delete / 富文本属性 / undo / 操作组合不在本实现内；
 * 本仓文件写入用的是行级 diff3 + 字符级细化，不依赖 OT。
 *
 * @maturity L2 — 真实实现 insert/insert 的成对变换；delete 与多端全序未实现
 * @maturityEvidence tests/unit/textOperationalTransform.test.ts
 */

/** 文本插入操作。 */
export interface TextInsertOperation {
  /** 插入位置（0..len）。 */
  readonly position: number;
  /** 插入文本（非空）。 */
  readonly text: string;
}

/** 成对变换结果。 */
export interface InsertTransformPair {
  /** 把 a 变换到 b 已应用之后。 */
  readonly aPrime: TextInsertOperation;
  /** 把 b 变换到 a 已应用之后。 */
  readonly bPrime: TextInsertOperation;
}

/** 插入 OT 工具（无状态）。 */
export class TextOperationalTransform {
  /**
   * 应用一个插入。
   * @param text 原文本。
   * @param op 插入操作。
   * @returns 新文本。
   * @throws RangeError 位置越界。
   */
  public static apply(text: string, op: TextInsertOperation): string {
    if (!Number.isInteger(op.position) || op.position < 0 || op.position > text.length) {
      throw new RangeError(
        `insert.position=${String(op.position)} 越界，应在 [0,${String(text.length)}]`,
      );
    }
    if (op.text === '') return text;
    return text.slice(0, op.position) + op.text + text.slice(op.position);
  }

  /**
   * 成对变换两个并发插入。
   * @param a 插入 A。
   * @param b 插入 B。
   * @returns 变换后的 A' / B'。
   */
  public static transform(a: TextInsertOperation, b: TextInsertOperation): InsertTransformPair {
    if (a.position < b.position) {
      return {
        aPrime: a,
        bPrime: { position: b.position + a.text.length, text: b.text },
      };
    }
    if (a.position > b.position) {
      return {
        aPrime: { position: a.position + b.text.length, text: a.text },
        bPrime: b,
      };
    }
    if (a.text === b.text) {
      // 同位置同文本仍是两个独立插入（不同客户端），不能静默去重；用同一平局规则定序。
      return {
        aPrime: a,
        bPrime: { position: b.position + a.text.length, text: b.text },
      };
    }
    // 同位置不同文本：字典序决定先后，两端得到同一顺序。
    if (a.text < b.text) {
      return {
        aPrime: a,
        bPrime: { position: b.position + a.text.length, text: b.text },
      };
    }
    return {
      aPrime: { position: a.position + b.text.length, text: a.text },
      bPrime: b,
    };
  }

  /**
   * 判断是否空操作。
   * @param op 插入操作。
   * @returns 空文本 true。
   */
  public static isNoop(op: TextInsertOperation): boolean {
    return op.text === '';
  }
}
