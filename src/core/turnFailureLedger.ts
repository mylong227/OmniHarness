/**
 * 验证失败**签名台账**（U2-2 VRR-Stop，2026-10-30）。
 *
 * ## 为什么
 *
 * 完成闸门在验证失败时把摘要回灌并「再给一步」——这条 verify-repair 回环的隐含假设是
 * 「再修一轮会有边际增益」。但验证器与修复器都有噪声（arXiv:2607.17641）：**同一失败签名**
 * 连续重复出现时，继续注入「再修」大概率在原地打转，甚至破坏本来正确的产物。
 * 本类把「失败签名是否与上次相同」变成可判定的状态，供 `TurnRunner` 执行停止规则：
 * 同签名 ⇒ 停止注入、如实记 `failed`；不同签名 ⇒ 允许下一轮。
 *
 * ## 口径
 *
 * 签名 = 摘要文本的**保守归一化**（小写 + 空白折叠）。刻意不做激进清洗（去数字/去行号）：
 * 误判「不同失败为相同」会提前止损（假阴性风险），误判「相同失败为不同」只是维持现状
 * （多回灌一次）——两害相权，保守归一化是安全侧。
 *
 * ## 生命周期
 *
 * 会话级（跨回合）：以 sessionId 为键存**最近一次**签名，由 `Agent` 持有单例、逐回合透传给
 * `TurnRunner`。表有界（512 会话，Map 插入序淘汰最旧），不提供显式清除——会话结束后条目
 * 只等淘汰，无泄漏面。
 */
export class TurnFailureLedger {
  /** 有界上限：超过即淘汰最早写入的会话（长驻服务防泄漏）。 */
  private static readonly MAX_SESSIONS = 512;

  /** 会话 → 最近一次失败签名（插入序淘汰最旧，防长驻服务泄漏）。 */
  private readonly last = new Map<string, string>();

  /**
   * 从失败摘要提取签名（小写 + 空白折叠；保守归一化，见类注释）。
   * @param digest 闸门返回的失败摘要。
   * @returns 归一化签名（空摘要返回空串——空串不参与比对，见调用方）。
   */
  public signatureOf(digest: string): string {
    return digest.replace(/\s+/gu, ' ').trim().toLowerCase();
  }

  /**
   * 该会话上一次失败签名是否与本签名相同。
   * @param sessionId 会话 id。
   * @param signature 归一化签名。
   * @returns 相同返回 true（从未记录过返回 false）。
   */
  public sameAsLast(sessionId: string, signature: string): boolean {
    return this.last.get(sessionId) === signature;
  }

  /**
   * 记录本会话最近一次失败签名（有界：超限淘汰最早写入的会话）。
   * @param sessionId 会话 id。
   * @param signature 归一化签名。
   * @returns 无返回值。
   */
  public record(sessionId: string, signature: string): void {
    this.last.delete(sessionId);
    this.last.set(sessionId, signature);
    if (this.last.size > TurnFailureLedger.MAX_SESSIONS) {
      const oldest = this.last.keys().next();
      if (!oldest.done) {
        this.last.delete(oldest.value);
      }
    }
  }
}

/**
 * 进程级共享单例：`Agent.buildTurnRunner` 逐回合新建 `TurnRunner`，而失败签名必须**跨回合**
 * 存续（同一会话的上一回合失败 ↔ 本回合比对）。放在 Agent 上会把它推过上帝类成员上限
 * （25→26，实测被增量门禁拦），故改为模块级单例、`TurnRunner` 构造参数缺省取它——
 * 测试仍可注入独立实例做隔离。
 */
export const sharedTurnFailureLedger = new TurnFailureLedger();
