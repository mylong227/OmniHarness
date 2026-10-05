/**
 * 进化系谱出证（商业化路线图 **H3**：「技能包附带'进化系谱'——由哪个失败签名演化而来、
 * 门禁裁决记录。**市场里没人能提供这个，因为没人在晋升环节留哈希链**」）。
 *
 * ## 它与"截图/自述"的根本区别
 *
 * 证书**自带可重算载荷**：每条资产的证据里带着台账条目的规范化字段（`ts/action/skills/promoted/rollbackTo/prev`）
 * 与当时的 `hash`。收证方拿到证书后，用**公开**的哈希口径（`HashChainPromotionLedger.hashOf`）
 * 就能自己重算一遍，并检查 `prev` 是否接得上——**不需要信任签发方的服务器，也不需要它在线**。
 *
 * ## 三条诚实纪律（都有判据）
 *
 * 1. **绝不编造系谱**：台账里找不到依据的资产标 `unproven` 并给出可读原因
 *    （"这个技能不是从本台账晋升来的"是**信息**，不是失败——假装有依据才是失败）；
 * 2. **链不可信则证书无效**：构建时先跑台账 `verify()`，链断 ⇒ `chain.verified=false`，
 *    且 `verify()` 直接判不合格（**不因为"内容是历史事实"就放行一份链已断的证明**）；
 * 3. **验不了就说验不了**：证书带签名但收证方没给信任根 ⇒ 报 `signatureChecked:false`
 *    （而不是"验签通过"）——安全面最贵的谎是"没查"被读成"查过了"。
 *
 * @maturity L1 — 逐条可重算 / 篡改可检出 / 未证来源如实标注 / 链断即无效 / 无信任根不谎报 判据钉死
 * @maturityEvidence tests/unit/provenanceCertificate.test.ts
 */
import { log } from '../util/logger.js';
import { HashChainPromotionLedger } from '../evolution/hashChainPromotionLedger.js';
import { Ed25519PublicKey } from '../util/ed25519PublicKey.js';
import type { PromotionLedgerEntry, PromotionLedgerPort } from '../ports/runtime/evolution.js';

/** 签发方身份（只要求两件；`Ed25519AgentIdentity` 直接满足）。 */
export interface ProvenanceIssuerIdentity {
  /** 公钥（`ssh-ed25519 …`）。 */
  readonly publicKeySsh: () => string;
  /** 对规范化正文签名（base64）。 */
  readonly sign: (payload: string) => string;
}

/** 一项资产的系谱。 */
export interface ProvenanceAsset {
  /** 资产名（技能/模板名）。 */
  readonly name: string;
  /** 来源判定：有台账依据 = `ledger-promotion`；查无依据 = `unproven`（**如实标注**）。 */
  readonly origin: 'ledger-promotion' | 'unproven';
  /** 晋升来源（`twist:a+b` / `pack:…` 等；仅 `ledger-promotion` 有）。 */
  readonly source?: string | undefined;
  /** **由哪个失败签名演化而来**（调用方按资产名映射传入；缺失即不写）。 */
  readonly failureSignature?: string | undefined;
  /** 门禁裁决记录（人类可读：晋升条目 + 其前最近快照锚点）。 */
  readonly verdicts: readonly string[];
  /** 可重算证据（台账条目原文 + 当时的哈希）。 */
  readonly evidence?: { readonly entry: PromotionLedgerEntry; readonly hash: string } | undefined;
  /** 查无依据时的可读原因（`unproven` 必有）。 */
  readonly unprovenReason?: string | undefined;
}

/** 系谱证书。 */
export interface ProvenanceCertificate {
  /** 证书格式版本。 */
  readonly version: 1;
  /** 被出证的包。 */
  readonly pack: { readonly name: string; readonly issuedAt: string };
  /** 台账链的可信度（构建时的完整性结论）。 */
  readonly chain: {
    readonly verified: boolean;
    readonly entries: number;
    /**
     * **证据起点锚点**：本证书覆盖的证据里最早那一条的 `prev`（无证据时为全零创世值）。
     *
     * 为什么必须有：没有它，"把第一条证据删掉"会产出一份**自洽**的证书
     * （剩下的条目之间仍首尾相接），收证方无从发现中间被抽走了东西。
     * 有锚点 ⇒ 首条证据的 `prev` 必须等于证书声称的锚点（判据 ③ 钉死）。
     */
    readonly coverageAnchor: string;
    readonly brokenAt?: number | undefined;
    readonly reason?: string | undefined;
  };
  /** 逐资产系谱。 */
  readonly assets: readonly ProvenanceAsset[];
  /** 签发方签名（缺省 = 未签名证书，仍然可复核哈希链）。 */
  readonly issuer?:
    { readonly publicKeySsh: string; readonly signatureEd25519: string } | undefined;
}

/** 系谱复核问题的**可机读码**（§12.1-4）。 */
export type ProvenanceProblemCode =
  | 'chain-broken'
  | 'evidence-missing'
  | 'hash-mismatch'
  | 'chain-link-broken'
  | 'anchor-mismatch'
  | 'untrusted-issuer'
  | 'signature-invalid';

/** 观测回调（缺省写共享 logger）。 */
export type ProvenanceObserver = (event: string, fields: Record<string, unknown>) => void;

/** 复核结论。 */
export interface ProvenanceVerification {
  /** 证书是否合格（链可信 + 每条证据可重算 + 有签名时验签通过）。 */
  readonly ok: boolean;
  /** 逐条问题（可读；`ok:true` 时为空）。 */
  readonly problems: readonly string[];
  /** 与 `problems` **一一对应**的可机读码（门禁/告警按码分流）。 */
  readonly codes: readonly ProvenanceProblemCode[];
  /** 逐资产复核结果（含 `unproven`，**不隐藏**）。 */
  readonly assets: readonly {
    readonly name: string;
    readonly origin: ProvenanceAsset['origin'];
    readonly recomputed: boolean;
  }[];
  /** 是否**真的**验了签名（无信任根时为 false——绝不把"没查"说成"查过"）。 */
  readonly signatureChecked: boolean;
}

/** 构建请求。 */
export interface ProvenanceBuildRequest {
  /** 包名。 */
  readonly packName: string;
  /** 签发时刻（ISO；由调用方给，保证证书可复现——不读墙钟）。 */
  readonly issuedAt: string;
  /** 要出证的资产（名 + 可选的失败签来源映射）。 */
  readonly assets: readonly {
    readonly name: string;
    readonly failureSignature?: string | undefined;
  }[];
  /** 签发身份（缺省 = 未签名证书）。 */
  readonly identity?: ProvenanceIssuerIdentity | undefined;
}

/** 系谱签发器。 */
export class ProvenanceIssuer {
  /**
   * @param ledger 晋升台账（唯一证据来源）
   */
  public constructor(private readonly ledger: PromotionLedgerPort) {}

  /**
   * 出证：逐资产在台账里找依据，找不到即标 `unproven`（**不编造**）。
   * @param request 构建请求
   * @returns 系谱证书
   */
  public build(request: ProvenanceBuildRequest): ProvenanceCertificate {
    const report = this.ledger.verify();
    const entries = this.ledger.list();
    const assets = request.assets.map((asset) => this.assetOf(asset, entries));
    const unsigned: ProvenanceCertificate = {
      version: 1,
      pack: { name: request.packName, issuedAt: request.issuedAt },
      chain: {
        verified: report.ok,
        entries: report.count,
        coverageAnchor: ProvenanceIssuer.anchorOf(assets),
        ...(report.ok ? {} : { brokenAt: report.brokenAt, reason: report.reason }),
      },
      assets,
    };
    if (request.identity === undefined) return unsigned;
    return {
      ...unsigned,
      issuer: {
        publicKeySsh: request.identity.publicKeySsh(),
        signatureEd25519: request.identity.sign(ProvenanceIssuer.canonical(unsigned)),
      },
    };
  }

  /**
   * 复核一份证书（**收证方独立执行**：不访问签发方的台账）。
   * @param certificate 证书
   * @param opts 信任根（给出才验签；缺省则 `signatureChecked:false`）
   * @returns 复核结论
   */
  public static verify(
    certificate: ProvenanceCertificate,
    opts: {
      readonly trustedPublicKeys?: readonly string[] | undefined;
      readonly observer?: ProvenanceObserver | undefined;
    } = {},
  ): ProvenanceVerification {
    const problems: string[] = [];
    const codes: ProvenanceProblemCode[] = [];
    const assets: { name: string; origin: ProvenanceAsset['origin']; recomputed: boolean }[] = [];
    if (!certificate.chain.verified) {
      problems.push(
        `台账链未通过完整性校验（断裂于 seq=${String(certificate.chain.brokenAt ?? '?')}：${certificate.chain.reason ?? '未说明'}）`,
      );
      codes.push('chain-broken');
    }
    let previousHash: string | undefined;
    for (const asset of certificate.assets) {
      // 起点锚点核对：**第一条**证据的 `prev` 必须等于证书声称的锚点，
      // 否则说明"中间/开头被抽掉了条目"——这类篡改在首尾相接的剩余条目里看不出来。
      if (
        previousHash === undefined &&
        asset.evidence !== undefined &&
        asset.evidence.entry.prev !== certificate.chain.coverageAnchor
      ) {
        problems.push(
          `证据起点与证书锚点不一致（首条证据 prev ${asset.evidence.entry.prev.slice(0, 12)}… ≠ 锚点 ${certificate.chain.coverageAnchor.slice(0, 12)}…：条目被删或被换）`,
        );
        codes.push('anchor-mismatch');
      }
      const recomputed = ProvenanceIssuer.recompute(asset, previousHash, problems, codes);
      assets.push({ name: asset.name, origin: asset.origin, recomputed });
      if (asset.evidence !== undefined) previousHash = asset.evidence.hash;
    }
    const signatureChecked = ProvenanceIssuer.checkSignature(certificate, opts, problems, codes);
    const verdict = { ok: problems.length === 0, problems, codes, assets, signatureChecked };
    // 结构化事件（§12.1-4）：复核是**出证链路**的判决点，通过与拒绝都要留痕。
    const emit =
      opts.observer ??
      ((event: string, fields: Record<string, unknown>) => {
        log.warn(event, fields);
      });
    emit(verdict.ok ? 'provenance.verified' : 'provenance.verify.failed', {
      pack: certificate.pack.name,
      codes,
      signatureChecked,
    });
    return verdict;
  }

  /**
   * 复核单条证据：重算哈希 + 检查链式连接。
   * @param asset 资产
   * @param previousHash 上一条证据的哈希（首条为 undefined）
   * @param problems 问题收集器（原地追加）
   * @returns 是否可重算通过（`unproven` 资产返回 false，但**不**计入问题）
   */
  private static recompute(
    asset: ProvenanceAsset,
    previousHash: string | undefined,
    problems: string[],
    codes: ProvenanceProblemCode[],
  ): boolean {
    if (asset.origin === 'unproven') {
      // 未证来源**不是**问题：证书如实说了"查无依据"，收证方据此自行判断。
      return false;
    }
    if (asset.evidence === undefined) {
      problems.push(`资产 ${asset.name} 标为已证但缺证据载荷（证书不完整）`);
      codes.push('evidence-missing');
      return false;
    }
    const expected = HashChainPromotionLedger.hashOf(asset.evidence.entry);
    if (expected !== asset.evidence.hash) {
      problems.push(
        `资产 ${asset.name} 的证据哈希对不上（自算 ${expected.slice(0, 12)}… ≠ 证书 ${asset.evidence.hash.slice(0, 12)}…）`,
      );
      codes.push('hash-mismatch');
      return false;
    }
    if (previousHash !== undefined && asset.evidence.entry.prev !== previousHash) {
      problems.push(`资产 ${asset.name} 的证据未接上上一条（断链或删条）`);
      codes.push('chain-link-broken');
      return false;
    }
    return true;
  }

  /**
   * 验签（无信任根时如实报"没查"）。
   * @param certificate 证书
   * @param opts 信任根
   * @param problems 问题收集器
   * @returns 是否真的验了签名
   */
  private static checkSignature(
    certificate: ProvenanceCertificate,
    opts: { readonly trustedPublicKeys?: readonly string[] | undefined },
    problems: string[],
    codes: ProvenanceProblemCode[],
  ): boolean {
    const issuer = certificate.issuer;
    if (issuer === undefined) return false;
    const trusted = opts.trustedPublicKeys ?? [];
    if (trusted.length === 0) {
      // 有签名但没信任根：**报"未检查"**，不是"通过"，也不是"失败"。
      return false;
    }
    const { issuer: _omit, ...unsigned } = certificate;
    const payload = ProvenanceIssuer.canonical(unsigned as ProvenanceCertificate);
    const keyOk = trusted.some((key) => ProvenanceIssuer.sameKey(key, issuer.publicKeySsh));
    if (!keyOk) {
      problems.push(`签发方公钥不在信任根内（${issuer.publicKeySsh.slice(0, 32)}…）`);
      codes.push('untrusted-issuer');
      return true;
    }
    if (!Ed25519PublicKey.verify(payload, issuer.signatureEd25519, issuer.publicKeySsh)) {
      problems.push('证书验签未通过（正文被改或签名不匹配）');
      codes.push('signature-invalid');
      return true;
    }
    return true;
  }

  /**
   * 规范化证书正文（**排除签名字段自身**；固定键序，避免"自己签的自己验不过"）。
   * @param certificate 证书
   * @returns 规范化 JSON
   */
  public static canonical(certificate: ProvenanceCertificate): string {
    return JSON.stringify({
      version: certificate.version,
      pack: { name: certificate.pack.name, issuedAt: certificate.pack.issuedAt },
      chain: certificate.chain,
      assets: certificate.assets.map((asset) => ({
        name: asset.name,
        origin: asset.origin,
        source: asset.source ?? null,
        failureSignature: asset.failureSignature ?? null,
        verdicts: asset.verdicts,
        evidence:
          asset.evidence === undefined
            ? null
            : {
                hash: asset.evidence.hash,
                entry: {
                  seq: asset.evidence.entry.seq,
                  ts: asset.evidence.entry.ts,
                  action: asset.evidence.entry.action,
                  skills: asset.evidence.entry.skills ?? null,
                  promoted: asset.evidence.entry.promoted ?? null,
                  rollbackTo: asset.evidence.entry.rollbackTo ?? null,
                  prev: asset.evidence.entry.prev,
                },
              },
        unprovenReason: asset.unprovenReason ?? null,
      })),
    });
  }

  /**
   * 取证据起点锚点（最早一条证据的 `prev`；无证据 ⇒ 全零创世值）。
   * @param assets 逐资产系谱
   * @returns 锚点哈希
   */
  private static anchorOf(assets: readonly ProvenanceAsset[]): string {
    const first = assets.find((asset) => asset.evidence !== undefined);
    return first?.evidence?.entry.prev ?? '0'.repeat(64);
  }

  /**
   * 取单个资产的系谱（在台账里按资产名找最近一次 `promote` 条目）。
   * @param asset 资产请求
   * @param entries 台账条目
   * @returns 系谱
   */
  private assetOf(
    asset: ProvenanceBuildRequest['assets'][number],
    entries: readonly PromotionLedgerEntry[],
  ): ProvenanceAsset {
    const hit = [...entries].reverse().find((entry) => entry.promoted?.name === asset.name);
    const base = {
      name: asset.name,
      ...(asset.failureSignature !== undefined ? { failureSignature: asset.failureSignature } : {}),
    };
    if (hit === undefined) {
      return {
        ...base,
        origin: 'unproven',
        verdicts: [],
        unprovenReason: `台账中无该资产的晋升条目（本台账共 ${String(entries.length)} 条）——本证书不为它作证`,
      };
    }
    // 门禁裁决记录：晋升条目本身 + 其前最近一次的快照锚点（"从哪个状态晋升上来"）。
    const snapshot = [...entries]
      .filter((entry) => entry.action === 'snapshot' && entry.seq < hit.seq)
      .pop();
    const verdicts = [
      `seq=${String(hit.seq)} promote ${asset.name} ← ${hit.promoted?.source ?? '?'}（hash ${hit.hash.slice(0, 12)}…，prev ${hit.prev.slice(0, 12)}…，ts ${hit.ts}）`,
      snapshot === undefined
        ? '无前置快照锚点（该晋升之前没有落过快照）'
        : `前置快照 seq=${String(snapshot.seq)}（${String(snapshot.skills?.length ?? 0)} 技能，ts ${snapshot.ts}）`,
    ];
    return {
      ...base,
      origin: 'ledger-promotion',
      source: hit.promoted?.source,
      verdicts,
      evidence: { entry: hit, hash: hit.hash },
    };
  }

  /**
   * 比较两把 SSH 公钥是否同一把（忽略注释段）。
   * @param a 公钥 A
   * @param b 公钥 B
   * @returns 是否同一把
   */
  private static sameKey(a: string, b: string): boolean {
    const norm = (key: string): string => key.trim().split(/\s+/).slice(0, 2).join(' ');
    return norm(a) === norm(b);
  }
}
