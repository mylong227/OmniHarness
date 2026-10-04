/**
 * 签名资产包端口（Wave D · ADR-0011 / EVOLVIX_SPEC §2 L4）。
 *
 * ## 契约边界（哪些事这里**不**做）
 *
 * - **不读文件、不验签、不装配**：本文件只声明「一个包长什么样、装进去得到什么报告、元数据长什么样」；
 *   编解码在 `src/asset/assetPackCodec.ts`，安装流水线在 `src/asset/assetPackInstaller.ts`；
 * - **不解释信任**：档位只声明「请求值」，是否可接受由安装流水线按「只可收紧」判据决定（§6 矩阵）。
 *
 * ## 失败语义（fail-closed 三条，沿 ADR-0011）
 *
 * 1. 无签名 / 坏签名 / 验签后篡改 ⇒ **整包拒**（严格档默认开；非严格档只用于本地开发且如实标 `unsigned`）；
 * 2. 任一资产过不了其类型的 `validate` ⇒ **整包拒**（不留部分安装）；
 * 3. 无台账 ⇒ **拒装**（无账不生效，与 Wave A/B 同一条纪律）。
 */
import type { IsolationLevel } from '../capability/isolationLevel.js';
import type { TrustTier } from '../capability/trustTier.js';

/** 资产包内的一条资产（本体 + 可选治理请求）。 */
export interface PackAssetEntry {
  /** 所属类型键（必须是安装方已注册的类型）。 */
  readonly schemaKind: string;
  /** 资产名（包内唯一；与既有资产重名即拒装）。 */
  readonly name: string;
  /** 资产本体（由所属类型 `validate` 把关）。 */
  readonly asset: unknown;
  /** 溯源：来源资产名 / 父候选。 */
  readonly parents?: readonly string[] | undefined;
  /** 溯源：产生它的算子（缺省由安装流水线写 `pack:install`）。 */
  readonly operator?: string | undefined;
  /** 治理**请求**（只可收紧；越权请求 ⇒ 整包拒，不静默取交集）。 */
  readonly governance?:
    | {
        /** 请求信任档。 */
        readonly trustTier?: TrustTier | undefined;
        /** 请求隔离档。 */
        readonly isolation?: IsolationLevel | undefined;
      }
    | undefined;
}

/** 资产包发布者（验签用的公钥来自这里，而非验签方自持的私钥）。 */
export interface PackPublisher {
  /** 发布者运行时身份 id。 */
  readonly runtimeId: string;
  /** 发布者公钥（`ssh-ed25519 <base64>`，与既有身份端口同格式）。 */
  readonly publicKeySsh: string;
}

/**
 * 资产包清单（被签名的正文 = 本结构去掉 `signature`）。
 *
 * `format` 是防误读的第一道闸：插件包用 `bundle.json`，资产包用 `asset-pack.json`，
 * 两者容器同为 zip，读取方按清单名分派（`assetPackCodec` 对缺清单/错清单显式报错，不猜）。
 */
export interface AssetPackManifest {
  /** 格式标识（恒 `omniharness-asset-pack`）。 */
  readonly format: 'omniharness-asset-pack';
  /** 清单版本（当前唯一合法值 1）。 */
  readonly version: 1;
  /** 包名（人类可读；进台账与报告）。 */
  readonly name: string;
  /** 发布者（验签公钥来源）。 */
  readonly publisher: PackPublisher;
  /** 签发时间（ISO；由签发方注入，编解码不读墙钟）。 */
  readonly issuedAt: string;
  /** 包内资产。 */
  readonly assets: readonly PackAssetEntry[];
  /** Ed25519 签名（base64；对规范化正文签名）。缺省 = 未签名包。 */
  readonly signature?: string | undefined;
}

/** 安装请求。 */
export interface AssetPackInstallRequest {
  /** 包字节（`.ohb` 容器；由调用方读盘或从网络取得——本端口不碰 IO）。 */
  readonly bytes: Uint8Array;
  /**
   * 是否要求签名（**缺省 true**：分发默认严格档）。
   * 显式 `false` 仅用于本地开发：装入资产一律记 `external` 档并在报告里标 `unsigned`。
   */
  readonly requireSignature?: boolean | undefined;
}

/** 安装报告（成功与失败同一形状：失败时 `ok:false` + 可读原因，绝不抛裸栈）。 */
export interface InstallReport {
  /** 是否装机成功。 */
  readonly ok: boolean;
  /** 已安装资产名（失败时为空数组——整包原子）。 */
  readonly installed: readonly string[];
  /** 发布者（验签通过或非严格档解析出时给出）。 */
  readonly publisher?: PackPublisher | undefined;
  /** 包装入的台账序号（成功且台账可用时给出）。 */
  readonly ledgerSeq?: number | undefined;
  /** 是否装入了未签名包（仅非严格档可能为 true；如实申报，不假装签过名）。 */
  readonly unsigned?: boolean | undefined;
  /** 拒装原因（`ok:false` 时必有，可行动）。 */
  readonly rejectedReason?: string | undefined;
}

/**
 * MCP Registry 字段风格的只读元数据（生态互描述的导出面）。
 *
 * 只导出**公开**信息：类型名/版本/默认档/资产名与档位——不含 instructions 明文等资产内容。
 */
export interface RegistryMetadata {
  /** 类型键。 */
  readonly kind: string;
  /** 契约版本。 */
  readonly version: number;
  /** 该类型默认信任档。 */
  readonly defaultTrustTier: TrustTier;
  /** 该类型默认隔离档。 */
  readonly defaultIsolation: IsolationLevel;
  /** 该类型当前资产摘要（仅公开字段）。 */
  readonly assets: readonly {
    /** 资产名。 */
    readonly name: string;
    /** 当前信任档。 */
    readonly trustTier: TrustTier;
    /** 当前隔离档。 */
    readonly isolation: IsolationLevel;
    /** 生命周期状态。 */
    readonly state: 'active' | 'frozen' | 'revoked';
    /** 溯核算子（`twist:a+b` / `crispr` / `pack:install`）。 */
    readonly operator: string;
  }[];
}

/** 资产包端口（L4）：装包 + 元数据导出。 */
export interface AssetPackPort {
  /**
   * 安装一个签名资产包（验签 → 全量预检 → 档位收紧 → 注册 + 台账）。
   * @param request 安装请求（包字节 + 是否要求签名）
   * @returns 安装报告（fail-closed：任何一步不过即整包拒，`rejectedReason` 可行动）
   */
  install(request: AssetPackInstallRequest): Promise<InstallReport>;
  /**
   * 导出某类型的只读元数据（不存在该类型时 undefined）。
   * @param kind 类型键
   * @returns MCP Registry 风格元数据或 undefined
   */
  metadataFor(kind: string): RegistryMetadata | undefined;
}
