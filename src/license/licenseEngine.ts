/**
 * License 引擎（商业化路线图 **F1**，阶段 1「单机商业版」）。
 *
 * ## 它回答什么
 *
 * 「这台机器上跑的是哪一档？」——`core`（开源全功能、进化闭环默认关）/ `pro` / `team` / `enterprise`。
 * 档位由**授权方用 Ed25519 私钥签发**的 license 决定，客户端只持**公钥**（非对称 ⇒ 客户端无法自造授权）。
 *
 * ## 两条硬判据（商业化报告 §5 阶段 1 原文）
 *
 * 1. **篡改 ⇒ 拒**：正文被改（档位/机器/有效期任一）或签名被换 ⇒ 一律回 `core`，且原因可读；
 * 2. **过期 ⇒ 降级为核心功能而非停摆**：过期**不是**错误路径上的"停用"，而是**档位退回 `core`**
 *    ——核心功能照常可用（本仓是开发者工具，"到期就罢工"会直接毁掉数据面信任）。
 *    故 `verify()` 对过期返回 `{ ok:false, expired:true, tier:'core' }`，**绝不抛错**。
 *
 * ## 其余纪律
 *
 * - **fail-closed**：无 license / 文本损坏 / 公钥非法 / 机器指纹不符 ⇒ 一律 `core` + 可读原因（不抛）；
 * - **机器绑定**：`machineFingerprint()` 由稳定的主机事实派生（hostname/platform/arch/CPU），
 *   同机恒同值、跨机不同；license 里的指纹不匹配即拒；
 * - **防未来签发**：`issuedAtMs` 明显晚于当前时刻（超出容差）⇒ 拒（挡"伪造未来签发"的粗糙变体）；
 * - **档位-功能映射显式**：{@link LicenseEngine.FEATURE_TIERS} 把"哪些功能要哪一档"写成**表**，
 *   调用方只问 `featureAllowed(tier, feature)`——不把档位判断散落到业务代码里。
 *
 * @maturity L1 — 篡改（正文/签名/机器/未来签发）四类拒 + 过期降级不停摆 + 空输入 fail-closed 判据钉死
 * @maturityEvidence tests/unit/licenseEngine.test.ts
 */
import { createHash } from 'node:crypto';
import type { LicenseTier } from '../ports/license/licenseTier.js';
import { log } from '../util/logger.js';
import { arch, cpus, hostname, platform } from 'node:os';
import { Ed25519PublicKey } from '../util/ed25519PublicKey.js';

/** 档位（由低到高；`core` 永远可用）。 */
export type { LicenseTier } from '../ports/license/licenseTier.js';

/** License 正文（**被签名**的部分；键序在规范化时固定）。 */
export interface LicensePayload {
  /** 授权 id（审计用）。 */
  readonly licenseId: string;
  /** 档位。 */
  readonly tier: Exclude<LicenseTier, 'core'>;
  /** 绑定的机器指纹（`LicenseEngine.machineFingerprint()` 的取值）。 */
  readonly machineFingerprint: string;
  /** 签发时刻（epoch ms）。 */
  readonly issuedAtMs: number;
  /** 到期时刻（epoch ms）。 */
  readonly expiresAtMs: number;
  /** 显式授予的功能名（缺省按档位表推导）。 */
  readonly features?: readonly string[] | undefined;
}

/** 授权校验的**可机读拒因码**（§12.1-4）。 */
export type LicenseDenialCode =
  'malformed' | 'signature-invalid' | 'machine-mismatch' | 'future-issued' | 'expired';

/** 观测回调（缺省写共享 logger；判据注入采集器以钉死事件口径）。 */
export type LicenseObserver = (event: string, fields: Record<string, unknown>) => void;

/** 缺省观测：走共享 logger。 */
const defaultObserver: LicenseObserver = (event, fields) => {
  log.warn(event, fields);
};

/** 校验结论（**同一形状**：失败也给档位，调用方永远拿得到一个可用的档位）。 */
export interface LicenseVerdict {
  /** 是否拿到有效授权（`core` 亦为 true —— 开源档不需要 license）。 */
  readonly ok: boolean;
  /** 生效档位（失败一律 `core`）。 */
  readonly tier: LicenseTier;
  /** 可读原因（`ok:true` 时为 `core` 缺省或通过说明）。 */
  readonly reason: string;
  /** 是否因**过期**而降级（调用方据此提示续期；`false` 表示其它原因或未过期）。 */
  readonly expired: boolean;
  /** **可机读**拒因码（`ok:true` 时为 undefined）。 */
  readonly code?: LicenseDenialCode | undefined;
  /** 正文（仅在验签通过时回带；供界面展示到期时间）。 */
  readonly payload?: LicensePayload | undefined;
}

/** 校验输入。 */
export interface LicenseVerifyInput {
  /** license 文本（PEM 风格的三段式；空/垃圾一律拒）。 */
  readonly text: string;
  /** 授权方公钥（`ssh-ed25519 …`；由部署方注入，客户端不可自造授权的根）。 */
  readonly publicKeySsh: string;
  /** 期望机器指纹（缺省用本机 `machineFingerprint()`）。 */
  readonly machineFingerprint?: string | undefined;
  /** 当前时刻（epoch ms；注入以便判据确定性）。 */
  readonly nowMs?: number | undefined;
  /** 签发时刻容差（毫秒；缺省 24 小时）。 */
  readonly issuedSkewMs?: number | undefined;
  /** 观测回调（缺省写共享 logger）。 */
  readonly observer?: LicenseObserver | undefined;
}

/** license 文本头（第一行）。 */
const LICENSE_HEADER = 'OH-LICENSE-1';

/** 缺省签发时刻容差：24 小时。 */
const DEFAULT_ISSUED_SKEW_MS = 24 * 60 * 60 * 1000;

/** License 引擎。 */
export class LicenseEngine {
  /**
   * 档位 → 功能的映射表（**唯一出处**：业务代码只问 `featureAllowed`，不自己比档位）。
   *
   * 与商业化报告 §6.1 的档位内容对齐：治理台属 Pro；技能库共享/私有源属 Team；SSO/RBAC 属 Enterprise。
   */
  public static readonly FEATURE_TIERS: Readonly<Record<string, LicenseTier>> = {
    // Core（开源）：harness 全功能 + 进化闭环（代码在、默认关）。
    harness: 'core',
    'evolution-local': 'core',
    // Pro：进化开启向导 + 治理台 + 增益月报 + 签名技能包制作。
    'governance-console': 'pro',
    'evolution-onboarding': 'pro',
    'lift-report': 'pro',
    'pack-signing': 'pro',
    // Team：多席位 + 技能库共享 + 审计中台 + 私有技能源。
    'shared-skill-library': 'team',
    'audit-console': 'team',
    'private-skill-source': 'team',
    // Enterprise：私有化 + SSO/RBAC + 合规导出 + SLA。
    sso: 'enterprise',
    rbac: 'enterprise',
    'compliance-export': 'enterprise',
  };

  /** 档位高低序（数值越大越高）。 */
  private static readonly TIER_RANK: Readonly<Record<LicenseTier, number>> = {
    core: 0,
    pro: 1,
    team: 2,
    enterprise: 3,
  };

  /**
   * 本机指纹：由稳定主机事实派生的短哈希（同机恒同值、跨机不同）。
   *
   * 口径：`hostname | platform | arch | CPU 型号`（**不读**用户目录/环境变量——那会引入 PII 与
   * 环境漂移，换 shell 就换指纹是不可接受的）。取 sha256 前 16 位十六进制。
   * @returns 16 位十六进制指纹
   */
  public static machineFingerprint(): string {
    const model = cpus()[0]?.model ?? 'unknown-cpu';
    const facts = [hostname(), platform(), arch(), model].join('|');
    return createHash('sha256').update(facts, 'utf8').digest('hex').slice(0, 16);
  }

  /**
   * 校验 license（fail-closed：任何一步不过 ⇒ `core` + 可读原因，**绝不抛**）。
   * @param input 校验输入
   * @returns 校验结论（含生效档位、原因、是否因过期降级）
   */
  public static verify(input: LicenseVerifyInput): LicenseVerdict {
    const observe = input.observer ?? defaultObserver;
    const parse = LicenseEngine.parse(input.text);
    if (typeof parse === 'string') {
      return LicenseEngine.core(parse, false, 'malformed', observe);
    }

    // ① 验签（用**授权方公钥**，非本地私钥）：正文被改或签名被换都在这里被挡下。
    const canonical = LicenseEngine.canonicalPayload(parse);
    if (!Ed25519PublicKey.verify(canonical, parse.signatureB64, input.publicKeySsh)) {
      return LicenseEngine.core(
        'license 验签未通过（正文被篡改或签名不匹配）',
        false,
        'signature-invalid',
        observe,
      );
    }

    // ② 机器绑定：指纹不符 ⇒ 拒（license 不可跨机复制）。
    const expected = input.machineFingerprint ?? LicenseEngine.machineFingerprint();
    if (parse.machineFingerprint !== expected) {
      return LicenseEngine.core(
        `license 绑定的机器指纹不符（license=${parse.machineFingerprint.slice(0, 8)}… 本机=${expected.slice(0, 8)}…）`,
        false,
        'machine-mismatch',
        observe,
      );
    }

    // ③ 防未来签发：明显晚于当前时刻 ⇒ 拒（挡粗糙的"伪造未来签发"变体）。
    const now = input.nowMs ?? Date.now();
    const skew = Math.max(0, input.issuedSkewMs ?? DEFAULT_ISSUED_SKEW_MS);
    if (parse.issuedAtMs > now + skew) {
      return LicenseEngine.core(
        'license 签发时刻晚于当前时刻（超出容差），拒绝采信',
        false,
        'future-issued',
        observe,
      );
    }

    // ④ 过期 ⇒ **降级为核心功能，不停摆**。
    if (now > parse.expiresAtMs) {
      const verdict = LicenseEngine.core(
        'license 已过期：退回核心档（核心功能照常可用，请续期）',
        true,
        'expired',
        observe,
      );
      return { ...verdict, payload: parse };
    }

    return {
      ok: true,
      tier: parse.tier,
      reason: `license 有效（${parse.tier}，到期 ${new Date(parse.expiresAtMs).toISOString()}）`,
      expired: false,
      payload: parse,
    };
  }

  /**
   * 某档位是否允许某功能（**唯一**档位判断入口）。
   * @param tier 当前档位
   * @param feature 功能名
   * @returns 允许为 true；**未登记的功能名一律 false**（fail-closed：新功能必须先登记档位）
   */
  public static featureAllowed(tier: LicenseTier, feature: string): boolean {
    const required = LicenseEngine.FEATURE_TIERS[feature];
    if (required === undefined) return false;
    return LicenseEngine.TIER_RANK[tier] >= LicenseEngine.TIER_RANK[required];
  }

  /**
   * 组一份 license 文本（**签发侧**；判据用它造夹具，真实签发在授权方侧完成）。
   *
   * 注意：本方法只做**拼装**，不持有私钥——签名由调用方（授权方）提供。
   * @param payload 正文
   * @param signatureB64 签名（对 {@link LicenseEngine.canonicalPayload} 的结果签）
   * @returns 三段式 license 文本
   */
  public static compose(payload: LicensePayload, signatureB64: string): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    return `${LICENSE_HEADER}\n${body}\n${signatureB64}\n`;
  }

  /**
   * 正文规范化（**签名与验签的共同输入**）：固定键序，避免"对象键序不稳定 ⇒ 验签假失败"。
   * @param payload 正文
   * @returns 规范化 JSON 字符串
   */
  public static canonicalPayload(payload: LicensePayload): string {
    return JSON.stringify({
      licenseId: payload.licenseId,
      tier: payload.tier,
      machineFingerprint: payload.machineFingerprint,
      issuedAtMs: payload.issuedAtMs,
      expiresAtMs: payload.expiresAtMs,
      features: payload.features ?? null,
    });
  }

  /**
   * 解析三段式 license 文本。
   * @param text license 文本
   * @returns 正文与签名；格式非法时返回**可读原因**（字符串）
   */
  private static parse(
    text: string,
  ): (LicensePayload & { readonly signatureB64: string }) | string {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (lines.length < 3) return 'license 格式非法：需要「头 / 正文 / 签名」三段';
    if (lines[0] !== LICENSE_HEADER) return `license 头非法："${lines[0]?.slice(0, 24) ?? ''}"`;
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(lines[1] ?? '', 'base64').toString('utf8'));
    } catch {
      return 'license 正文不是合法 JSON（base64 段损坏）';
    }
    if (typeof decoded !== 'object' || decoded === null) return 'license 正文必须是对象';
    const record = decoded as Partial<LicensePayload>;
    if (typeof record.licenseId !== 'string' || record.licenseId.trim() === '') {
      return 'license 缺 licenseId';
    }
    if (record.tier !== 'pro' && record.tier !== 'team' && record.tier !== 'enterprise') {
      return `license 档位非法："${String(record.tier)}"`;
    }
    if (typeof record.machineFingerprint !== 'string' || record.machineFingerprint === '') {
      return 'license 缺 machineFingerprint';
    }
    if (typeof record.issuedAtMs !== 'number' || typeof record.expiresAtMs !== 'number') {
      return 'license 缺签发/到期时刻';
    }
    if (record.expiresAtMs <= record.issuedAtMs) return 'license 到期时刻必须晚于签发时刻';
    return { ...(record as LicensePayload), signatureB64: lines[2] ?? '' };
  }

  /**
   * 降到核心档的结论。
   * @param reason 可读原因
   * @param expired 是否因过期降级
   * @returns 结论
   */
  private static core(
    reason: string,
    expired: boolean,
    code: LicenseDenialCode,
    observe: LicenseObserver,
  ): LicenseVerdict {
    // 结构化事件（§12.1-4）：每个拒绝路径都留下**可机读 code**，不只留一句人话。
    observe('license.verdict.denied', { code, expired });
    return { ok: false, tier: 'core', reason, expired, code };
  }
}
