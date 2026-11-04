import { createHash } from 'node:crypto';
import { AuditCanonical } from './auditCanonical.ts';
import type { AuditChainedRecord, AuditChainVerification, AuditRecord } from './auditTypes.ts';

/**
 * 审计报告的哈希链（append-only 完整性检测）。
 *
 * 算法：`hash_n = SHA-256(prev_n + "\n" + canonical(record_n))`，`prev_1` 为创世哈希。
 * 这是**完整性检测**，不是签名：
 * - 能检出"报告被改了 / 中间被删了 / 记录被换了顺序"；
 * - 不能证明"报告出自谁之手"——任何拿到报告的人都能重算一条自洽的新链。
 * 需要来源可信时，报告要与调用方的留存副本 / 外部时间戳一起使用（见 `docs/audit/ATTESTATION.md`）。
 *
 * 这里刻意**不加 HMAC**：出证报告是给对方看的，密钥不能随报告一起交付；而审计链的
 * HMAC 模式（`kernel/util/hashChain.ts`，服务于落盘日志防篡改）在"交付给第三方复核"场景下
 * 反而会让对方无法验证。两者场景不同，不合并。
 */
export class AuditChain {
  /** 创世前驱哈希（全零 64 hex）：让首条记录也纳入链校验。 */
  public static readonly GENESIS = '0'.repeat(64);

  /** 链式分隔符（固定值，改动即改变历史哈希；复核器必须用同一值）。 */
  public static readonly SEPARATOR = '\n';

  /** 报告头封印的域标签（把「链头封印」与普通记录链哈希区分开）。 */
  public static readonly SEAL_LABEL = 'redaction';

  /**
   * 给记录编号并上链。
   * @param records 已按时间顺序排列、已带 seq 的规范化记录。
   * @returns 带 `prev` / `hash` 的记录数组（顺序与入参一致）。
   */
  public link(records: readonly AuditRecord[]): AuditChainedRecord[] {
    const chained: AuditChainedRecord[] = [];
    let prev = AuditChain.GENESIS;
    for (const record of records) {
      const hash = this.hashOf(prev, AuditCanonical.stringify(record));
      chained.push({ prev, hash, record });
      prev = hash;
    }
    return chained;
  }

  /**
   * 逐条重算并校验链。
   * @param records 报告里的带链记录。
   * @returns 校验结果（第一处不一致的位置与原因）。
   */
  public verify(records: readonly AuditChainedRecord[]): AuditChainVerification {
    let prev = AuditChain.GENESIS;
    for (let index = 0; index < records.length; index += 1) {
      const item = records[index];
      if (item === undefined) {
        continue;
      }
      if (item.prev !== prev) {
        return {
          ok: false,
          brokenAt: index,
          reason: index === 0 ? 'genesis' : 'prev',
        };
      }
      const expected = this.hashOf(prev, AuditCanonical.stringify(item.record));
      if (item.hash !== expected) {
        return { ok: false, brokenAt: index, reason: 'hash' };
      }
      prev = item.hash;
    }
    return { ok: true, brokenAt: null, reason: null };
  }

  /**
   * 报告头封印：把脱敏摘要绑定进 `integrity.head`（2026-11-04 P3 T3.2）。
   *
   * 公式：`SHA-256(链头 + "\n" + "redaction\n" + 规范JSON(redaction))`。
   *
   * 脱敏摘要不在 `records` 里，不封印的话「删掉 `redaction` 字段」或「把 mode 改回 off」
   * 就能绕过 hits 对账——这正是方案要求的「防删了痕迹」。非脱敏报告（无 redaction 或
   * mode off）仍用裸链头，存量报告不受影响。浏览器内嵌复核器实现了同一公式。
   * @param head 链头（末条记录哈希；空链为创世哈希）。
   * @param canonicalRedaction 脱敏摘要的规范 JSON（`AuditCanonical.stringify`）。
   * @returns 64 位十六进制封印。
   */
  public seal(head: string, canonicalRedaction: string): string {
    return this.hashOf(
      head,
      `${AuditChain.SEAL_LABEL}${AuditChain.SEPARATOR}${canonicalRedaction}`,
    );
  }

  /**
   * 取链头（空链返回创世哈希）。
   * @param records 带链记录。
   * @returns 最后一条的哈希。
   */
  public headOf(records: readonly AuditChainedRecord[]): string {
    const last = records[records.length - 1];
    return last === undefined ? AuditChain.GENESIS : last.hash;
  }

  /**
   * 计算单条链哈希。
   * @param prev 前驱哈希。
   * @param canonical 记录的规范 JSON。
   * @returns 64 位十六进制摘要。
   */
  private hashOf(prev: string, canonical: string): string {
    return createHash('sha256')
      .update(prev)
      .update(AuditChain.SEPARATOR)
      .update(canonical)
      .digest('hex');
  }
}
