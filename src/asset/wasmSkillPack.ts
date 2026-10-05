/**
 * wasm 技能包（**Wave C 产品工作**：把进化产物打成 `wasm-skill` 资产包，并在装包时**真在 wasm 档冒烟**）。
 *
 * ## 它把 J8 与资产层接起来
 *
 * - `WasmSkillSchema`（本模块的配套类型）规定资产体长什么样、默认档位是 `evolved` + `wasm`；
 * - 本模块负责**造包**（`build`）与**生成冒烟载荷**（`smokePayloadFor`）；
 * - `AssetPackInstaller` 在装配期用 `smokePayloadFor` 拿到 `wasm-module` 载荷，交给
 *   `IsolationLadder` 的 `wasm` 档执行——**跑不起来就装不上**（J8 的强制在此生效）。
 *
 * ## 三条一致性（本模块存在的理由）
 *
 * 1. **冒烟载荷与运行时载荷同源**：都由资产体里的 `entry` / `input` / `fuel` 生成。
 *    若各写一份，"装的是一套、跑的是另一套"——而这类不一致只在生产上炸。
 * 2. **base64 与 `Buffer` 的往返只在两处**（`build` 写入、`payloadOf` 读出），别处不许手搓。
 * 3. **缺字段即不冒烟**（返回 `undefined`）而不是"用默认值凑一个"：凑出来的载荷可能恰好能跑，
 *    于是掩盖了"这个资产其实没声明入口"。
 *
 * @maturity L1 — 造包往返 / 冒烟载荷与资产体同源 / 缺入口不冒充 / 非 wasm 技能返回 undefined 判据钉死
 * @maturityEvidence tests/unit/wasmSkillPack.test.ts
 */
import { AssetPackCodec } from './assetPackCodec.js';
import type { PackSigningIdentity } from './assetPackCodec.js';
import { WasmSkillSchema } from '../capability/schemas/wasmSkillSchema.js';
import type { WasmSkillAsset } from '../capability/schemas/wasmSkillSchema.js';
import type { AssetPackManifest, PackAssetEntry } from '../ports/asset/assetPack.js';
import type { CapabilityRecord } from '../ports/capability.js';
import type { IsolationPayload } from '../ports/runtime/isolation.js';

/** 冒烟/运行共用的默认入参（`ping` 是最小闭环：证明宿主写内存 → 调用 → 读回 → 释放可用）。 */
const DEFAULT_INPUT = '{"jsonrpc":"2.0","id":1,"method":"ping"}';

/** 造包请求。 */
export interface WasmSkillPackRequest {
  /** 包名。 */
  readonly name: string;
  /** 发布时间（ISO；由调用方给，保证可复现）。 */
  readonly issuedAt: string;
  /** 技能条目（可多个；各自带模块字节）。 */
  readonly skills: readonly {
    readonly name: string;
    readonly description: string;
    /** wasm 模块字节（本方法负责 base64 编码，调用方不必手搓）。 */
    readonly moduleBytes: Uint8Array;
    /** C-ABI 入口名（缺省 `process`）。 */
    readonly entry?: string | undefined;
    /** 入参（缺省 `ping`）。 */
    readonly input?: string | undefined;
    /** 预算（缺省 1_000_000；本档要求显式声明）。 */
    readonly fuel?: number | undefined;
  }[];
  /**
   * 发布者身份（**必填**：由 `AssetPackCodec.sign` 写入实际公钥并签名）。
   *
   * 为什么必填而不是给个"匿名占位键"：装包路径**会校验发布者公钥**，占位键（如 `ssh-ed25519 AAAA`）
   * 在验签阶段必被拒 ⇒ 造出来的包**根本装不上**。与其产出一个装不上的包，不如在造包期就要身份
   * ——"进化产物有出处"本就是本仓的治理口径。
   */
  readonly publisher: { readonly runtimeId: string; readonly identity: PackSigningIdentity };
}

/** wasm 技能包工具。 */
export class WasmSkillPack {
  private constructor() {}

  /**
   * 造一个 `wasm-skill` 资产包（含签名，若给了发布者）。
   * @param request 造包请求
   * @returns 包字节（`AssetPackCodec.encode` 的产物）
   */
  public static build(request: WasmSkillPackRequest): Buffer {
    const schema = new WasmSkillSchema();
    const assets: PackAssetEntry[] = request.skills.map((skill) => {
      const asset: WasmSkillAsset = {
        name: skill.name,
        description: skill.description,
        moduleBase64: Buffer.from(skill.moduleBytes).toString('base64'),
        entry: skill.entry ?? 'process',
        input: skill.input ?? DEFAULT_INPUT,
        fuel: skill.fuel ?? 1_000_000,
      };
      const verdict = schema.validate(asset);
      if (!verdict.ok) {
        // 造包期就拒：把非法资产写进包，只会在装包期以更难查的形式炸（且包可能已被分发）。
        throw new Error(`wasm 技能 ${skill.name} 非法：${verdict.reason}`);
      }
      return {
        schemaKind: schema.kind,
        name: skill.name,
        asset,
        governance: { trustTier: 'evolved', isolation: 'wasm' },
      };
    });
    const manifest: AssetPackManifest = {
      format: 'omniharness-asset-pack',
      version: 1,
      name: request.name,
      publisher: {
        runtimeId: request.publisher.runtimeId,
        publicKeySsh: request.publisher.identity.publicKeySsh(),
      },
      issuedAt: request.issuedAt,
      assets,
    };
    // 签名统一走 `AssetPackCodec.sign`（它同时把**实际公钥**写回清单）：手搓 publisher 会让
    // "清单里声明的公钥"与"真正签名的密钥"不一致，而那是验签阶段最难查的一类失败。
    return AssetPackCodec.encode(AssetPackCodec.sign(manifest, request.publisher.identity));
  }

  /**
   * 生成装配期冒烟载荷：**从资产体读**（不另传参）。
   *
   * 这是与运行时的唯一同源点：入口/入参/预算都取自资产体，装的时候跑什么，运行时就跑什么。
   * @param record 待装资产记录
   * @returns `wasm-module` 载荷；非本类型或缺字段时 `undefined`（⇒ 不冒烟，而不是凑一个）
   */
  public static smokePayloadFor(record: CapabilityRecord): IsolationPayload<unknown> | undefined {
    if (record.schemaKind !== 'wasm-skill') return undefined;
    const asset = record.asset as Partial<WasmSkillAsset>;
    if (typeof asset.moduleBase64 !== 'string' || asset.moduleBase64 === '') return undefined;
    if (typeof asset.entry !== 'string' || asset.entry.trim() === '') {
      // **不冒充**：没声明入口就不冒烟（凑一个默认入口可能恰好能跑，从而掩盖"资产没声明入口"）。
      return undefined;
    }
    return {
      kind: 'wasm-module',
      bytes: new Uint8Array(Buffer.from(asset.moduleBase64, 'base64')),
      entry: asset.entry,
      input: asset.input ?? DEFAULT_INPUT,
      fuel: asset.fuel ?? 1_000_000,
    };
  }
}
