import { createHash } from 'node:crypto';

/**
 * 哈希链的**共享算法**（审计 §3.5「审计哈希链两份同构且已语义分叉」的收口）。
 *
 * ## 背景（为什么会有这个模块）
 *
 * 仓内有两条 append-only 哈希链：审计日志（`server/services/auditSink.ts`）与长期运行遥测
 * （`adapters/telemetry/jsonlRuntimeTelemetry.ts`）。两者的**链式算法本该完全一致**
 * （`hash_n = SHA256(prev_n ‖ sep ‖ canonical(e_n))`），却各自实现了一份：常量 `GENESIS`、
 * 分隔符 `SEP`、`hashOf` 两份拷贝 ⇒ 任一处改动都可能只改一边，而这类分叉**不会报错**，
 * 只会在某天验签旧日志时才发现链条断裂（与 §20.8 的「口径漂移」同型）。
 *
 * 现在算法与创世哈希只在这里一份；两条链各自**只保留自己的规范化正文**（见下）。
 *
 * ## 刻意**不**统一的部分：分隔符
 *
 * 两条链的分隔符历史上就不同（审计链用 NUL，遥测链用空格）。**不能统一**：
 * 改分隔符＝改历史哈希 ⇒ 已落盘的审计/遥测链当场验签失败（`verify()` 会判链条断裂）。
 * 故 `hash()` 把分隔符作为**入参**，由调用方固定并注明理由；两条链的取值由
 * `tests/unit/hashChain.test.ts` 的 golden 哈希逐字节钉死。
 */
export class HashChain {
  /**
   * 创世前驱哈希：首条记录的 `prev`，使首条也纳入链校验（全零 64 hex）。
   *
   * 为什么不用空串：空串与「缺失 prev」不可区分，会让首条记录成为**可被静默替换**的弱点。
   */
  public static readonly GENESIS = '0'.repeat(64);

  /**
   * 计算链哈希：`SHA256(prev ‖ sep ‖ canonical)` 的 hex。
   *
   * 拼接顺序固定为「前驱 ‖ 分隔符 ‖ 正文」；`prev` 恒为 64 hex、`sep` 由调用方固定，
   * 故拼接点无歧义（正文中出现同样的字符也不会造成另一种切分）。
   * @param prev 前一条记录的哈希（首条传 {@link HashChain.GENESIS}）。
   * @param canonical 该条记录的规范化正文（**不含** prev/hash 自身——它们是被保护对象）。
   * @param sep 分隔符（调用方固定；审计链为 NUL，遥测链为空格，见模块注释）。
   * @returns 64 位十六进制摘要。
   */
  public static hash(prev: string, canonical: string, sep: string): string {
    return createHash('sha256').update(prev).update(sep).update(canonical).digest('hex');
  }
}
