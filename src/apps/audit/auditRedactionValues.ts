import { createHash } from 'node:crypto';

/**
 * 脱敏的**纯值工具**（路径规范化 / 末两段 / 哈希 / 熵）——2026-11-04 P3。
 *
 * 从 `AuditRedactor` 拆出的原因很具体：规则类加上这四个方法会到 29 个方法，
 * 触发编码标准的「上帝类」门禁（单类 > 25 方法）。这里全是无状态纯函数，
 * 不依赖脱敏规则，独立成类后规则类回到 25 个方法。
 *
 * 同值同标的口径在这里：`normalizePath` 是哈希与显示**共用**的规范形态
 * （`\`→`/`、折叠连续斜杠、小写），否则同一语义路径的三种书写形态会算出三个标记。
 */
export class AuditRedactionValues {
  /** 标记里原值哈希的位数（可对账、不可还原的折中）。 */
  public static readonly HASH_CHARS = 8;

  /**
   * 路径的规范形态（正斜杠、无连续斜杠、小写）——哈希与显示共用的同值判定基础。
   * @param raw 原始书写形态。
   * @returns 规范化路径。
   */
  public static normalizePath(raw: string): string {
    return raw
      .replaceAll('\\', '/')
      .replace(/\/{2,}/g, '/')
      .toLowerCase();
  }

  /**
   * 规范路径的末两段（不足两段给全部）。
   * @param canonicalPath 规范路径。
   * @returns 末两段文本。
   */
  public static lastTwoSegments(canonicalPath: string): string {
    const segments = canonicalPath.split('/').filter((segment) => segment !== '');
    return segments.slice(-2).join('/');
  }

  /**
   * 原值 SHA-256 前 8 位（跨记录对账用；不可还原）。
   * @param value 原值。
   * @returns 8 位十六进制。
   */
  public static hash8(value: string): string {
    return createHash('sha256')
      .update(value, 'utf8')
      .digest('hex')
      .slice(0, AuditRedactionValues.HASH_CHARS);
  }

  /**
   * 按字符频率的香农熵（bits/字符）。
   * @param text 文本。
   * @returns 熵值（空串为 0）。
   */
  public static entropyOf(text: string): number {
    if (text === '') {
      return 0;
    }
    const counts = new Map<string, number>();
    for (const char of text) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    let entropy = 0;
    for (const count of counts.values()) {
      const p = count / text.length;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }
}
