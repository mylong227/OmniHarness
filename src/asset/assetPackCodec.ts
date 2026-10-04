/**
 * 资产包编解码（Wave D · ADR-0011）：`.ohb` 容器读写 + **Ed25519 非对称**签名与验签。
 *
 * ## 为什么是「非对称」而不是沿用插件包的 HMAC
 *
 * HMAC 的验签方必须持有签名密钥 ⇒ 「谁能验签」等于「谁能伪造」；分发场景下这是错的。
 * 本类验签用的是**清单里发布者的公钥**（`publisher.publicKeySsh`），
 * 因此任何第三方都能独立验签，而只有发布者能签。
 *
 * ## 容器与清单
 *
 * 容器仍是仓内既有的 `.ohb`（zip，复用 `Zip.zipStore/unzip`），但清单名为 `asset-pack.json`
 * ——与插件包的 `bundle.json` 语义隔离。读包时**按清单名分派**：缺清单、类型不符、
 * 或误把插件包当资产包喂进来，都显式报错（绝不 sniffing 猜）。
 *
 * ## 签名的保护范围（已知边界，ADR-0011 已登记）
 *
 * 签名覆盖**清单规范化正文**（固定键序、排除 `signature` 自身）。v1 的资产是清单内联 JSON，
 * 故「签了清单 = 签了全部内容」；将来若包内引入独立文件，必须先把文件摘要并入清单再签。
 *
 * @maturity L1 — 三类验签失败（无签名/坏签名/篡改）与容器误读判据钉死（含变异自证）
 * @maturityEvidence tests/unit/assetPackCodec.test.ts
 */
import { verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { Ed25519PublicKey } from '../util/ed25519PublicKey.js';
import type { AgentIdentityPort } from '../ports/runtime/agentIdentity.js';
import type { AssetPackManifest, PackPublisher } from '../ports/asset.js';
import { Zip } from '../plugin/zip.js';

/** 包内清单条目名（与插件包的 `bundle.json` 语义隔离）。 */
export const ASSET_PACK_ENTRY = 'asset-pack.json';

/** 格式标识（写包与读包都校验它，防误读）。 */
const FORMAT = 'omniharness-asset-pack';

/** 验签结论（fail-closed：失败必带可行动原因）。 */
export type PackVerification =
  | { readonly ok: true; readonly publisher: PackPublisher; readonly signed: boolean }
  | { readonly ok: false; readonly reason: string };

/** 签名身份的最小面（既有 `AgentIdentityPort` 结构性满足；只取签名需要的两个成员）。 */
export type PackSigningIdentity = Pick<AgentIdentityPort, 'sign' | 'publicKeySsh' | 'runtimeId'>;

/** 资产包编解码器（纯静态：无状态、确定性、不读 IO）。 */
export class AssetPackCodec {
  private constructor() {}

  /**
   * 清单的**规范化正文**（签名/验签的共同输入）。
   *
   * 固定键序 + 逐条资产固定键序：JSON 的对象键序在实现间不可依赖，若直接 `JSON.stringify`
   * 原对象，签名与验签可能算出不同字节 ⇒ 假失败（或更糟：为「让它过」而放宽比较）。
   * @param manifest 清单（`signature` 被排除——它是被保护对象，不是正文）
   * @returns 规范化 JSON 字符串
   */
  public static canonicalPayload(manifest: AssetPackManifest): string {
    return JSON.stringify({
      format: manifest.format,
      version: manifest.version,
      name: manifest.name,
      publisher: {
        runtimeId: manifest.publisher.runtimeId,
        publicKeySsh: manifest.publisher.publicKeySsh,
      },
      issuedAt: manifest.issuedAt,
      assets: manifest.assets.map((entry) => ({
        schemaKind: entry.schemaKind,
        name: entry.name,
        asset: entry.asset,
        parents: entry.parents ?? null,
        operator: entry.operator ?? null,
        governance: entry.governance ?? null,
      })),
    });
  }

  /**
   * 用发布者身份对清单签名，产出完整的签名清单。
   * @param manifest 未签名清单（`signature` 应为空）
   * @param identity 发布者身份（只用到 `sign` 与 `publicKeySsh`）
   * @returns 带签名的清单（新对象，不改原对象）
   */
  public static sign(
    manifest: AssetPackManifest,
    identity: PackSigningIdentity,
  ): AssetPackManifest {
    const publisher: PackPublisher = {
      runtimeId: manifest.publisher.runtimeId,
      publicKeySsh: identity.publicKeySsh(),
    };
    const payload = AssetPackCodec.canonicalPayload({ ...manifest, publisher });
    return { ...manifest, publisher, signature: identity.sign(payload) };
  }

  /**
   * 验签：无签名 / 坏签名 / 验签后篡改三类一律 `ok:false`（J9 的核心）。
   * @param manifest 待验清单
   * @returns 验签结论（成功时回带发布者与「是否签过名」）
   */
  public static verify(manifest: AssetPackManifest): PackVerification {
    if (manifest.format !== FORMAT) {
      return { ok: false, reason: `不是资产包清单（format=${String(manifest.format)}）` };
    }
    const publicKey = AssetPackCodec.decodePublicKey(manifest.publisher);
    if (typeof publicKey === 'string') {
      return { ok: false, reason: publicKey };
    }
    if (manifest.signature === undefined || manifest.signature === '') {
      return { ok: false, reason: 'unsigned' };
    }
    try {
      const payload = AssetPackCodec.canonicalPayload(manifest);
      const ok = cryptoVerify(
        null,
        Buffer.from(payload, 'utf8'),
        publicKey,
        Buffer.from(manifest.signature, 'base64'),
      );
      return ok
        ? { ok: true, publisher: manifest.publisher, signed: true }
        : { ok: false, reason: 'bad-signature' };
    } catch (err) {
      return {
        ok: false,
        reason: `bad-signature:${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 把清单封成 `.ohb` 字节（zip 容器，单一清单条目）。
   * @param manifest 清单（通常已签名）
   * @returns 包字节
   */
  public static encode(manifest: AssetPackManifest): Buffer {
    return Zip.zipStore([
      {
        name: ASSET_PACK_ENTRY,
        data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      },
    ]);
  }

  /**
   * 解出清单（缺清单 / JSON 非法 / 误把插件包喂进来都在此显式报错）。
   * @param bytes 包字节
   * @returns 清单
   * @throws 容器或清单不可解析时抛错（fail-closed，绝不返回半个对象）
   */
  public static decode(bytes: Uint8Array): AssetPackManifest {
    const entries = Zip.unzip(Buffer.from(bytes));
    const entry = entries.find((e) => e.name === ASSET_PACK_ENTRY);
    if (entry === undefined) {
      const names = entries.map((e) => e.name).join(', ');
      throw new Error(
        `不是资产包：缺少 ${ASSET_PACK_ENTRY}（包内条目：${names === '' ? '（空）' : names}）`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.data.toString('utf8'));
    } catch (err) {
      throw new Error(`资产包清单 JSON 非法：${err instanceof Error ? err.message : String(err)}`);
    }
    return AssetPackCodec.asManifest(parsed);
  }

  /**
   * 结构校验（收窄 `unknown` → `AssetPackManifest`）：字段缺失/类型不符即抛。
   * @param value 待收窄值
   * @returns 清单
   * @throws 结构非法时抛错
   */
  private static asManifest(value: unknown): AssetPackManifest {
    if (typeof value !== 'object' || value === null) {
      throw new Error('资产包清单必须是对象');
    }
    const record = value as Partial<AssetPackManifest>;
    if (record.format !== FORMAT) {
      throw new Error(`资产包 format 非法："${String(record.format)}"（应为 ${FORMAT}）`);
    }
    if (record.version !== 1) {
      throw new Error(`资产包 version 非法："${String(record.version)}"（当前只支持 1）`);
    }
    if (typeof record.name !== 'string' || record.name.trim() === '') {
      throw new Error('资产包缺 name');
    }
    if (
      typeof record.publisher !== 'object' ||
      record.publisher === null ||
      typeof record.publisher.publicKeySsh !== 'string' ||
      typeof record.publisher.runtimeId !== 'string'
    ) {
      throw new Error('资产包缺 publisher（runtimeId + publicKeySsh）');
    }
    if (typeof record.issuedAt !== 'string') {
      throw new Error('资产包缺 issuedAt');
    }
    if (!Array.isArray(record.assets)) {
      throw new Error('资产包缺 assets 数组');
    }
    return record as AssetPackManifest;
  }

  /**
   * 解出发布者公钥（`ssh-ed25519 <base64>` → KeyObject）。
   *
   * 为什么自己解：仓内既有身份适配器只提供**自己的**公钥编码，没有「拿别人的公钥验签」这条路；
   * 而分发层必须能用发布者公钥验签。格式是 RFC 4253 的 SSH 字符串（4 字节大端长度 + 内容），
   * 32 字节原始密钥套上 RFC 8410 的 SPKI 前缀即可交给 `node:crypto`。
   * @param publisher 发布者
   * @returns 公钥；格式非法时返回**可读原因**（字符串）
   */
  private static decodePublicKey(publisher: PackPublisher): KeyObject | string {
    // 委托公共工具：同一份 ssh-ed25519 → SPKI 解码被分发层（本文件）与 License 引擎（F1）共用，
    // 两处各写一份必然漂移——尤其"公钥格式非法"这类 fail-closed 分支。
    return Ed25519PublicKey.decodeSsh(publisher.publicKeySsh);
  }
}
