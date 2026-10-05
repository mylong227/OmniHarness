/**
 * 私有技能源（商业化路线图 **G2**「技能包团队分发」）。
 *
 * ## 它解决什么
 *
 * 现状：`.ohb` 只有**可选 HMAC**（对称密钥），且解包时"没签名就照装"。两个问题：
 * 1. **对称**：能验的成员也能伪造——团队分发要的是"人人可验、只有发布者可签"；
 * 2. **可选**：没有"必须签名"这一档，于是"无签名包"在团队源里畅通无阻（G2 判据正是这一条）。
 *
 * 本模块把团队源做成一个**受策略约束的来源**：枚举源目录里的 `.ohb`，逐个裁决
 * （Ed25519 验签 + 信任根 + 内容完整性），严格档下**无签名即拒**；放行集才交给既有的安装路径。
 *
 * ## 三个信任档（**不静默提档**）
 *
 * | 档 | 条件 | 严格档 | 宽松档 |
 * | --- | --- | --- | --- |
 * | `verified` | Ed25519 签名有效 **且**公钥在信任根内 | 接收 | 接收 |
 * | `community` | 无签名（或仅 HMAC，对称、不可公开验证） | **拒绝** | 接收（**如实标注档位**） |
 * | （拒） | 签名无效 / 公钥不在信任根 / 内容被改 | 拒绝 | 拒绝 |
 *
 * 关键取舍：**宽松档也不把无签名包当 `verified`**。把"能用"与"可信"混为一谈，是分发系统最贵的谎。
 *
 * ## 只做裁决，不碰安装实现
 *
 * 安装走注入的 {@link PrivateSkillSourceOptions.install} 回调（组合根接既有的
 * `AssetPackInstaller`：verify → prepare → smoke → register → record）。本模块**不复制**那条链路——
 * 复制就会漂移，而"两边对不上"在分发场景里等于绕过了门禁。
 *
 * @maturity L1 — 严格档无签名拒 / 非信任根拒 / 篡改拒 / 宽松档标注 community / 只装放行集 判据钉死
 * @maturityEvidence tests/unit/privateSkillSource.test.ts
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Ed25519PublicKey } from '../util/ed25519PublicKey.js';
import { PluginBundler } from './pluginBundler.js';
import { BundleCodec } from './bundleCodec.js';
import type { BundleManifest } from './pluginBundler.js';

/** 签名档位（**不静默提档**：无签名永远是 community）。 */
export type BundleTrustTier = 'verified' | 'community';

/** 单个包的裁决结论。 */
export interface SkillSourceEntry {
  /** 包文件名（源目录内的相对名）。 */
  readonly file: string;
  /** 包名（清单 `name`；清单读不出来时为文件名）。 */
  readonly name: string;
  /** 版本（清单 `version`；缺省 `?`）。 */
  readonly version: string;
  /** 是否放行（true ⇒ 可进入安装路径）。 */
  readonly accepted: boolean;
  /** 信任档（放行时才有意义；拒绝时为 `community`——即"未被证实"）。 */
  readonly tier: BundleTrustTier;
  /** 拒绝原因（放行时为 undefined；必须可读且可行动）。 */
  readonly reason?: string | undefined;
  /** 签名形态（审计展示用）。 */
  readonly signatureKind: 'ed25519' | 'hmac' | 'none';
}

/** 一次同步的结果。 */
export interface SkillSourceSyncReport {
  /** 逐包裁决（与 `list()` 同序）。 */
  readonly entries: readonly SkillSourceEntry[];
  /** 实际进入安装路径的包名。 */
  readonly installed: readonly string[];
  /** 被拒包名（附原因在 `entries` 里）。 */
  readonly refused: readonly string[];
}

/** 私有技能源选项。 */
export interface PrivateSkillSourceOptions {
  /** 源目录（团队私有源；只读枚举其中的 `*.ohb`）。 */
  readonly sourceDir: string;
  /** 信任根：允许的发布者公钥（`ssh-ed25519 …`）。**空数组 ⇒ 严格档下一切皆拒**（fail-closed）。 */
  readonly trustedPublicKeys: readonly string[];
  /**
   * 严格档：`true` ⇒ 只接收 `verified`（无签名一律拒，G2 判据）；`false` ⇒ 接收 `community` 但**如实标注**。
   */
  readonly strict: boolean;
  /** 单次扫描的包数上限（缺省 256）：源是分发渠道，无上限等于让源目录决定宿主读多少文件。 */
  readonly maxBundles?: number | undefined;
  /** 单包字节上限（缺省 64 MiB）：先 stat 再读，超限**直接拒**而不是读进来再判断。 */
  readonly maxBundleBytes?: number | undefined;
  /** 安装回调（组合根接既有安装路径）；拒绝的包**永不**进入这里。 */
  readonly install: (request: {
    readonly path: string;
    readonly manifest: BundleManifest;
  }) => Promise<void>;
}

/** 私有技能源：枚举 → 裁决 → （仅放行集）安装。 */
export class PrivateSkillSource {
  /** 规范化后的信任根指纹集合（比较公钥主体，忽略注释）。 */
  private readonly trusted: ReadonlySet<string>;
  /** 单次扫描包数上限。 */
  private readonly maxBundles: number;
  /** 单包字节上限。 */
  private readonly maxBundleBytes: number;

  /**
   * @param opts 源目录 / 信任根 / 严格档 / 安装回调
   */
  public constructor(private readonly opts: PrivateSkillSourceOptions) {
    this.trusted = new Set(
      opts.trustedPublicKeys.map((key) => PrivateSkillSource.normalizeKey(key)),
    );
    this.maxBundles = Math.max(1, Math.floor(opts.maxBundles ?? 256));
    this.maxBundleBytes = Math.max(1, Math.floor(opts.maxBundleBytes ?? 64 * 1024 * 1024));
  }

  /**
   * 枚举源目录并逐个裁决（**只读**：不安装、不写盘）。
   * @returns 逐包裁决（按文件名升序，确定性）
   */
  public list(): readonly SkillSourceEntry[] {
    const files = this.bundleFiles();
    return files.map((file) => this.judge(file));
  }

  /**
   * 同步：对**放行**的包调用安装回调；拒绝的一个都不装（fail-closed）。
   *
   * 为什么要在报告里同时给 `entries` 与 `refused`：运维第一问是"为什么这个包没装上"，
   * 只报"装了几个"会让人去翻日志。
   * @returns 同步报告
   */
  public async sync(): Promise<SkillSourceSyncReport> {
    const entries: (SkillSourceEntry & { readonly manifest?: BundleManifest | undefined })[] = [];
    const installed: string[] = [];
    const refused: string[] = [];
    // 一次判定、一次使用：不在判定与安装之间重读文件（否则"判的是 A、装的是 B"）。
    for (const file of this.bundleFiles()) {
      const judged = this.judge(file);
      entries.push(judged);
      if (!judged.accepted || judged.manifest === undefined) {
        refused.push(judged.name);
        continue;
      }
      await this.opts.install({ path: join(this.opts.sourceDir, file), manifest: judged.manifest });
      installed.push(judged.name);
    }
    return { entries, installed, refused };
  }

  /**
   * 枚举源目录内的 `*.ohb`（按名升序；目录不存在 ⇒ 空数组，不是错误）。
   * @returns 文件名列表
   */
  private bundleFiles(): readonly string[] {
    try {
      const all = readdirSync(this.opts.sourceDir)
        .filter((name) => name.endsWith('.ohb'))
        .sort();
      // 上限是**拒绝**而不是"截断到前 N 个"：静默少读会让"同步成功"变成假象。
      if (all.length > this.maxBundles) {
        throw new Error(
          `源目录包数超限（${String(all.length)} > ${String(this.maxBundles)}）：上限见 maxBundles`,
        );
      }
      return all;
    } catch {
      return []; // 源目录尚未建立（新团队）= 空源，不是错误。
    }
  }

  /**
   * 裁决单个包（读清单 → 验签 → 信任根 → 严格档）。
   * @param file 包文件名
   * @returns 裁决结论（含解析出的清单，供安装路径复用）
   */
  private judge(
    file: string,
  ): SkillSourceEntry & { readonly manifest?: BundleManifest | undefined } {
    const manifest = this.loadOrRefuse(file);
    if ('file' in manifest) return manifest;
    const base = { file, name: manifest.name, version: manifest.version, manifest };
    const signatureKind = PrivateSkillSource.signatureKindOf(manifest);
    if (manifest.signatureEd25519 !== undefined && manifest.publisherPublicKey !== undefined) {
      return this.judgeSigned(base, signatureKind);
    }
    return this.judgeUnsigned(base, signatureKind);
  }

  /**
   * 读清单；读不出即给出**拒绝结论**（返回结论对象而不是抛错，调用方无需 try）。
   * @param file 包文件名
   * @returns 清单，或一条"拒绝"结论
   */
  private loadOrRefuse(
    file: string,
  ): BundleManifest | (SkillSourceEntry & { readonly manifest?: undefined }) {
    const refuse = (reason: string): SkillSourceEntry & { readonly manifest?: undefined } => ({
      file,
      name: file,
      version: '?',
      accepted: false,
      tier: 'community',
      signatureKind: 'none',
      reason,
    });
    const path = join(this.opts.sourceDir, file);
    try {
      // **先 stat 再读**：超限直接拒，而不是"读进来再判断"——后者在大包上已经把内存吃掉了。
      const size = statSync(path).size;
      if (size > this.maxBundleBytes) {
        return refuse(
          `包体积超限（${String(size)} > ${String(this.maxBundleBytes)} 字节）：上限见 maxBundleBytes`,
        );
      }
      const manifest = PrivateSkillSource.readManifest(path);
      return manifest ?? refuse('包内缺 bundle.json 清单（不是合法 .ohb）');
    } catch (err) {
      return refuse(`无法读取包清单（${err instanceof Error ? err.message : String(err)}）`);
    }
  }

  /**
   * 裁决**带 Ed25519 签名**的包：验签 + 信任根两道都过才放行。
   * @param base 基础条目（含清单）
   * @param signatureKind 签名形态
   * @returns 结论
   */
  private judgeSigned(
    base: {
      readonly file: string;
      readonly name: string;
      readonly version: string;
      readonly manifest: BundleManifest;
    },
    signatureKind: SkillSourceEntry['signatureKind'],
  ): SkillSourceEntry & { readonly manifest: BundleManifest } {
    const { manifest } = base;
    const key = manifest.publisherPublicKey ?? '';
    const signature = manifest.signatureEd25519 ?? '';
    if (!Ed25519PublicKey.verify(PluginBundler.canonicalManifestOf(manifest), signature, key)) {
      return {
        ...base,
        signatureKind,
        accepted: false,
        tier: 'community',
        reason: 'Ed25519 验签未通过（清单被改或签名不匹配）',
      };
    }
    if (!this.trusted.has(PrivateSkillSource.normalizeKey(key))) {
      return {
        ...base,
        signatureKind,
        accepted: false,
        tier: 'community',
        reason: `签名有效但发布者不在信任根内（${key.slice(0, 32)}…）`,
      };
    }
    return { ...base, signatureKind, accepted: true, tier: 'verified' };
  }

  /**
   * 裁决**无 Ed25519 签名**的包：严格档拒（G2 判据），宽松档收下但标注 `community`。
   * @param base 基础条目（含清单）
   * @param signatureKind 签名形态
   * @returns 结论
   */
  private judgeUnsigned(
    base: {
      readonly file: string;
      readonly name: string;
      readonly version: string;
      readonly manifest: BundleManifest;
    },
    signatureKind: SkillSourceEntry['signatureKind'],
  ): SkillSourceEntry & { readonly manifest: BundleManifest } {
    if (this.opts.strict) {
      return {
        ...base,
        signatureKind,
        accepted: false,
        tier: 'community',
        reason:
          signatureKind === 'hmac'
            ? '严格档要求 Ed25519 签名：HMAC 是对称的（能验者即可伪造），不作为分发凭据'
            : '严格档要求 Ed25519 签名：该包无签名',
      };
    }
    // 宽松档也不提档：无签名永远是 community（把「能用」与「可信」混为一谈是分发系统最贵的谎）。
    return { ...base, signatureKind, accepted: true, tier: 'community' };
  }

  /**
   * 签名形态判定（审计展示用）。
   * @param manifest 清单
   * @returns `ed25519` / `hmac` / `none`
   */
  private static signatureKindOf(manifest: BundleManifest): SkillSourceEntry['signatureKind'] {
    if (manifest.signatureEd25519 !== undefined) return 'ed25519';
    return manifest.signature !== undefined ? 'hmac' : 'none';
  }

  /**
   * 读包内清单（`.ohb` = 无压缩 zip store；复用具名条目读取）。
   * @param path 包路径
   * @returns 清单；包内无清单时为 undefined
   */
  private static readManifest(path: string): BundleManifest | undefined {
    // 复用共享读取器（zip-store 解析的唯一出处）；缺清单/畸形包一律返回 undefined，
    // 由调用方给出可读拒绝原因（不在这里抛，保持"拒绝"与"异常"分离）。
    const read = BundleCodec.readManifestJson(path);
    return read.ok ? (read.json as BundleManifest) : undefined;
  }

  /**
   * 规范化公钥（只用「算法 + 主体」，忽略 authorized_keys 里的注释段）。
   * @param key SSH 公钥
   * @returns 规范化字符串
   */
  private static normalizeKey(key: string): string {
    const parts = key.trim().split(/\s+/);
    return `${parts[0] ?? ''} ${parts[1] ?? ''}`;
  }
}
