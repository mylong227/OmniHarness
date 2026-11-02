import { createHash } from 'node:crypto';
import { AuditChain } from './auditChain.ts';
import { AuditReportStore } from './auditReportStore.ts';
import type { AuditChainVerification, AuditOutputFormat, AuditReport } from './auditTypes.ts';

/**
 * 报告复核器：重算哈希链 + 核对摘要字段 + 文件级自指纹。
 *
 * 判据口径：**任何一处对不上都失败**，并给出位置与原因（`schema` / `genesis` / `prev` /
 * `hash` / `head` / `count` / `algorithm` / `artifact` / `artifact-missing`）。宁可报
 * "这份报告不可信"，也不做"大概没问题"的模糊结论——出证工具的价值全在这一条上。
 */
export class AuditReportVerifier {
  /** 链实现。 */
  private readonly chain: AuditChain;

  /**
   * @param chain 哈希链（缺省新建）。
   */
  public constructor(chain: AuditChain = new AuditChain()) {
    this.chain = chain;
  }

  /**
   * 复核一份报告。
   * @param report 报告对象（从 HTML/Markdown/JSON 里取出的载荷）。
   * @returns 校验结果。
   */
  public verify(report: AuditReport): AuditChainVerification {
    if (report.schema !== 'omniharness.audit.report/v1') {
      return { ok: false, brokenAt: null, reason: 'schema' };
    }
    if (report.integrity.algorithm !== 'sha256') {
      return { ok: false, brokenAt: null, reason: 'algorithm' };
    }
    if (report.integrity.genesis !== AuditChain.GENESIS) {
      return { ok: false, brokenAt: null, reason: 'genesis' };
    }
    const chain = this.chain.verify(report.records);
    if (!chain.ok) {
      return chain;
    }
    if (report.integrity.count !== report.records.length) {
      return { ok: false, brokenAt: null, reason: 'count' };
    }
    const head = this.chain.headOf(report.records);
    if (report.integrity.head !== head) {
      return {
        ok: false,
        brokenAt: report.records.length === 0 ? null : report.records.length - 1,
        reason: 'head',
      };
    }
    return { ok: true, brokenAt: null, reason: null };
  }

  /**
   * 复核一份**落盘报告**：先校验载荷链，再校验文件级自指纹（HTML / Markdown）。
   * @param report 从文件里取出的报告。
   * @param text 文件原文。
   * @param format 文件格式。
   * @returns 校验结果。
   */
  public verifyFile(
    report: AuditReport,
    text: string,
    format: AuditOutputFormat,
  ): AuditChainVerification {
    const chain = this.verify(report);
    if (!chain.ok || format === 'json') {
      return chain;
    }
    const artifact = report.artifact;
    if (artifact === undefined || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      return { ok: false, brokenAt: null, reason: 'artifact-missing' };
    }
    // 摘要只在载荷里出现一次；出现 0 次或多次都判失败（多次 = 有人把摘要抄进正文，
    // 让"替换后重算"产生歧义，无法可靠复原）。
    const parts = text.split(artifact.sha256);
    if (parts.length !== 2) {
      return { ok: false, brokenAt: null, reason: 'artifact' };
    }
    const restored = `${parts[0] ?? ''}${AuditReportStore.ARTIFACT_TOKEN}${parts[1] ?? ''}`;
    const expected = createHash('sha256').update(restored, 'utf8').digest('hex');
    return expected === artifact.sha256
      ? { ok: true, brokenAt: null, reason: null }
      : { ok: false, brokenAt: null, reason: 'artifact' };
  }
}
