/**
 * 资产包安装流水线（Wave D · ADR-0011 / EVOLVIX_SPEC §4 F3）：`AssetPackPort` 的实现。
 *
 * ## 五步顺序（每一步的失败都是「整包拒」）
 *
 * 1. **解包 + 验签**：`AssetPackCodec.decode` → `verify`。严格档（默认）下无签名即拒；
 *    非严格档只用于本地开发，且装入资产的信任档一律按 `external` 起算并在报告里标 `unsigned`。
 * 2. **全量预检**：逐资产查「类型是否已注册 / `validate` 是否通过 / 名字是否已被占用 /
 *    档位请求是否只收紧」。**全部通过才进入写入**——这是「不留部分安装」的实现方式
 *    （不是先写再回滚：那会把回滚本身变成一条要长期维护的代码路径）。
 * 3. **入册**（`registry.put`）：写入期若仍意外抛错，则把本轮已入册的资产逐个撤销后整包拒
 *    ——**账上不留假记录**。
 * 4. **入账**：每个资产一条 `action: 'pack-install'` 条目（Ω-2：任何资产变更 = 链上一个条目）。
 *    台账缺失 ⇒ 整包拒（无账不生效，沿 ADR-0008/0009 的同一条纪律）。
 * 5. **出报告**：成功给 `installed` + `ledgerSeq`；失败给 `ok:false` + `rejectedReason`。
 *
 * ## 顺序为什么是「先入册后入账」
 *
 * 反过来的话，入册失败的资产已经在链上留了 `pack-install` 条目——账说装了、实际没装，
 * 这正是「账实不符」。当前顺序下，账上出现的每一条 `pack-install` 都对应一次真实入册。
 *
 * @maturity L1 — J9 三类全拒 + 整包原子 + 档位只收紧 + 无台账拒装 判据钉死
 * @maturityEvidence tests/unit/assetPackInstaller.test.ts
 */
import { AssetPackCodec } from './assetPackCodec.js';
import type {
  AssetPackInstallRequest,
  AssetPackManifest,
  AssetPackPort,
  InstallReport,
  PackAssetEntry,
  RegistryMetadata,
} from '../ports/asset.js';
import { ISOLATION_LEVEL_ORDER, TRUST_TIER_ORDER } from '../ports/capability.js';
import type {
  CapabilityRecord,
  CapabilityRegistryPort,
  CapabilitySchemaRegistryPort,
  IsolationLevel,
  TrustTier,
} from '../ports/capability.js';
import type { PromotionLedgerPort } from '../ports/runtime/evolution.js';
import type { IsolationPayload, IsolationPort } from '../ports/runtime/isolation.js';

/** 装配项。 */
export interface AssetPackInstallerOptions {
  /** 目标注册表（入册面）。 */
  readonly registry: CapabilityRegistryPort;
  /** 类型注册表（校验与默认档来源）。 */
  readonly schemas: CapabilitySchemaRegistryPort;
  /** 台账（**缺省 = 拒装**：无账不生效）。 */
  readonly ledger?: PromotionLedgerPort | undefined;
  /**
   * 装配下限（与 `CapabilityStackAssembler` 同源；缺省 `evolved` / `vm`——
   * 外来资产按「进化产物」档起步）。
   */
  readonly defaults:
    { readonly trustTier: TrustTier; readonly isolation: IsolationLevel } | undefined;
  /** ISO 时间戳注入（记录出生时间；本类不读墙钟）。 */
  readonly now?: (() => string) | undefined;
  /**
   * 隔离阶梯（Wave C · ADR-0010）：注入后启用**档位门禁 + 冒烟**（§4 F3 的第四步）。
   * 缺省 = 不检查（行为与 Wave D2 完全一致，零回归）。
   */
  readonly isolation?: IsolationPort | undefined;
  /**
   * 档位原生冒烟载荷（可选）：为更严档位（`vm` / `os-sandbox` / `wasm`）提供**该档能跑**的载荷。
   *
   * 缺省（不提供）= 更严档位**不冒烟**，理由见文件内注释：「宿主闭包型冒烟」在更严档位上
   * 本来就跑不了（跨 realm 会得到假隔离），强行跑只会得到一句 `payload-unsupported`；
   * 而数据型资产没有自带代码——真正要冒烟的是**资产自带的代码**，那要等有代码型资产。
   */
  readonly smokePayloadFor?:
    ((record: CapabilityRecord) => IsolationPayload<unknown> | undefined) | undefined;
}

/** 预检通过的待装条目（含算好的档位）。 */
interface PreparedAsset {
  /** 包内条目。 */
  readonly entry: PackAssetEntry;
  /** 生效信任档（已收紧）。 */
  readonly trustTier: TrustTier;
  /** 生效隔离档（已收紧）。 */
  readonly isolation: IsolationLevel;
}

/**
 * 档位计算结论。
 *
 * **为什么必须用判别式，而不是「成功给档位、失败给字符串」**：档位本身就是字符串
 * （`TrustTier` / `IsolationLevel` 都是字符串联合），于是 `typeof x === 'string'` 判不出错误——
 * 本片开发期真实踩到：合法档位 `'external'` 被当成拒绝原因，安装报告直接吐出 `rejectedReason: "external"`。
 * 判据当场变红，这条注释就是留给下一个人的。
 */
type TierOutcome<T extends string> =
  { readonly ok: true; readonly tier: T } | { readonly ok: false; readonly reason: string };

/** 资产包安装器：验签 → 预检 → 入册 → 入账 → 报告。 */
export class AssetPackInstaller implements AssetPackPort {
  /** 目标注册表。 */
  private readonly registry: CapabilityRegistryPort;
  /** 类型注册表。 */
  private readonly schemas: CapabilitySchemaRegistryPort;
  /** 台账（undefined = 拒装）。 */
  private readonly ledger?: PromotionLedgerPort | undefined;
  /** 装配下限。 */
  private readonly defaults: {
    readonly trustTier: TrustTier;
    readonly isolation: IsolationLevel;
  };
  /** 时间戳注入。 */
  private readonly now: () => string;
  /** 隔离阶梯（undefined = 不做档位门禁与冒烟）。 */
  private readonly isolation?: IsolationPort | undefined;
  /** 档位原生冒烟载荷提供者。 */
  private readonly smokePayloadFor?:
    ((record: CapabilityRecord) => IsolationPayload<unknown> | undefined) | undefined;

  /**
   * @param opts 注册表 / 类型注册表 / 台账 / 档位下限 / 时钟 / 隔离阶梯 / 冒烟载荷
   */
  public constructor(opts: AssetPackInstallerOptions) {
    this.registry = opts.registry;
    this.schemas = opts.schemas;
    this.ledger = opts.ledger;
    this.defaults = opts.defaults ?? { trustTier: 'evolved', isolation: 'vm' };
    this.now = opts.now ?? ((): string => new Date().toISOString());
    this.isolation = opts.isolation;
    this.smokePayloadFor = opts.smokePayloadFor;
  }

  /**
   * 安装一个签名资产包（fail-closed：任何一步不过即整包拒）。
   * @param request 安装请求（包字节 + 是否要求签名）
   * @returns 安装报告
   */
  public async install(request: AssetPackInstallRequest): Promise<InstallReport> {
    let manifest: AssetPackManifest;
    try {
      manifest = AssetPackCodec.decode(request.bytes);
    } catch (err) {
      return AssetPackInstaller.reject(err instanceof Error ? err.message : String(err));
    }
    const verdict = AssetPackCodec.verify(manifest);
    const requireSignature = request.requireSignature !== false;
    if (!verdict.ok && (verdict.reason !== 'unsigned' || requireSignature)) {
      return AssetPackInstaller.reject(`验签未通过（${verdict.reason}）`);
    }
    if (this.ledger === undefined) {
      return AssetPackInstaller.reject('无台账不生效：安装被拒（请先配置晋升台账）');
    }
    const prepared = this.prepare(manifest, verdict.ok);
    if (typeof prepared === 'string') return AssetPackInstaller.reject(prepared);
    const smoke = await this.smoke(prepared);
    if (typeof smoke === 'string') return AssetPackInstaller.reject(smoke);
    const installed = this.register(prepared);
    if (typeof installed === 'string') return AssetPackInstaller.reject(installed);

    const firstSeq = this.record(manifest, prepared, installed);
    return {
      ok: true,
      installed,
      publisher: manifest.publisher,
      ledgerSeq: firstSeq,
      ...(verdict.ok ? {} : { unsigned: true }),
    };
  }

  /**
   * 档位门禁 + 冒烟（§4 F3 的第四步；未注入隔离阶梯时整体跳过 = 零回归）。
   *
   * 两步的分工（**这两件事不是一回事，混起来会得到假安全**）：
   * 1. **档位可达性门禁**：资产声明的档位若在本机不可达（如 `wasm`——wasmtime 未准入）⇒ 整包拒。
   *    理由：装了也跑不了，且**绝不允许**安装时把档位降下来凑合（ADR-0010 决策 2）；
   * 2. **冒烟评估**：
   *    - 声明档位是 `in-process` ⇒ 在阶梯内跑一次该类型的度量（宿主闭包载荷，这一档能承载它）；
   *      抛错/超时 ⇒ 整包拒（把「装完才发现评估就炸」提前到安装时）；
   *    - 更严档位 ⇒ 默认**不冒烟**（宿主闭包跨 realm 只会得到 `payload-unsupported`；
   *      数据型资产也没有自带代码可跑）。组合根若提供 `smokePayloadFor`，则按该档原生载荷冒烟。
   * @param prepared 待装条目
   * @returns undefined = 通过；字符串 = 拒装原因
   */
  private async smoke(prepared: readonly PreparedAsset[]): Promise<string | undefined> {
    if (this.isolation === undefined) return undefined;
    for (const item of prepared) {
      if (!this.isolation.available(item.isolation)) {
        return `资产 ${item.entry.name} 声明的隔离档 ${item.isolation} 在本机不可达：拒装（不降档；ADR-0010）`;
      }
      const record = AssetPackInstaller.recordOf(item, this.now());
      const payload = this.smokePayload(item, record);
      if (payload === undefined) continue;
      const result = await this.isolation.run({ asset: record, payload, level: item.isolation });
      if (!result.ok) {
        return `资产 ${item.entry.name} 冒烟未通过（${result.denied.code}）：${result.denied.reason}`;
      }
    }
    return undefined;
  }

  /**
   * 取冒烟载荷：`in-process` 档用「跑一次该类型度量」的宿主闭包；更严档位用注入的原生载荷。
   * @param item 待装条目
   * @param record 资产记录（档位已收紧）
   * @returns 载荷；不适用时为 undefined（= 该资产不冒烟，见 `smoke` 注释）
   */
  private smokePayload(
    item: PreparedAsset,
    record: CapabilityRecord,
  ): IsolationPayload<unknown> | undefined {
    const native = this.smokePayloadFor?.(record);
    if (native !== undefined) return native;
    if (item.isolation !== 'in-process') return undefined;
    const schema = this.schemas.schemaOf(item.entry.schemaKind);
    return {
      kind: 'closure',
      run: () => schema.evalContract({ evaluator: 'install-smoke' })(item.entry.asset),
    };
  }

  /**
   * 导出某类型的只读元数据（MCP Registry 风格；不含资产内容）。
   * @param kind 类型键
   * @returns 元数据或 undefined（类型未注册）
   */
  public metadataFor(kind: string): RegistryMetadata | undefined {
    if (!this.schemas.has(kind)) return undefined;
    const schema = this.schemas.schemaOf(kind);
    const assets = this.registry.recordsOfKind(kind).map((record) => ({
      name: AssetPackInstaller.nameOf(record),
      trustTier: record.governance.trustTier,
      isolation: record.governance.isolation,
      state: record.governance.state,
      operator: record.lineage.operator,
    }));
    return {
      kind,
      version: schema.version,
      defaultTrustTier: schema.defaultTrustTier,
      defaultIsolation: schema.defaultIsolation,
      assets,
    };
  }

  /**
   * 全量预检（不写任何状态）：类型 / 校验 / 重名 / 档位只收紧。
   * @param manifest 清单
   * @param signed 验签是否通过（未签名包起始档为 `external`）
   * @returns 待装条目；任一项不过时返回**可读原因**（字符串）
   */
  private prepare(manifest: AssetPackManifest, signed: boolean): PreparedAsset[] | string {
    const prepared: PreparedAsset[] = [];
    const seen = new Set<string>();
    for (const entry of manifest.assets) {
      if (!this.schemas.has(entry.schemaKind)) {
        return `资产类型未注册：${entry.schemaKind}（资产 ${entry.name}）`;
      }
      const schema = this.schemas.schemaOf(entry.schemaKind);
      const validation = schema.validate(entry.asset);
      if (!validation.ok) {
        return `资产校验不通过（${entry.name}）：${validation.reason}`;
      }
      if (seen.has(entry.name)) return `包内资产重名：${entry.name}`;
      seen.add(entry.name);
      if (
        this.registry.recordOf(entry.name) !== undefined ||
        this.registry.get(entry.name) !== undefined
      ) {
        return `资产已存在：${entry.name}（升级请走 setGovernance/替换路径，不做静默覆盖）`;
      }
      const trustOutcome = this.tightenTier(entry, signed);
      if (!trustOutcome.ok) return trustOutcome.reason;
      const isolationOutcome = this.tightenIsolation(entry);
      if (!isolationOutcome.ok) return isolationOutcome.reason;
      prepared.push({
        entry,
        trustTier: trustOutcome.tier,
        isolation: isolationOutcome.tier,
      });
    }
    return prepared;
  }

  /**
   * 算信任档（只可收紧）：下限 = 装配下限与「未签名包 external 档」的更严者；
   * 请求档比下限更松 ⇒ 直接拒（不静默取交集）。
   * @param entry 待装条目
   * @param signed 验签是否通过
   * @returns 档位结论（判别式，见 {@link TierOutcome}）
   */
  private tightenTier(entry: PackAssetEntry, signed: boolean): TierOutcome<TrustTier> {
    const base = AssetPackInstaller.stricter(
      TRUST_TIER_ORDER,
      this.defaults.trustTier,
      signed ? undefined : 'external',
    );
    const requested = entry.governance?.trustTier;
    if (requested === undefined) return { ok: true, tier: base };
    if (TRUST_TIER_ORDER.indexOf(requested) < TRUST_TIER_ORDER.indexOf(base)) {
      return {
        ok: false,
        reason: `资产 ${entry.name} 的信任档请求放宽（${base} → ${requested}）：只可收紧，整包拒`,
      };
    }
    return { ok: true, tier: requested };
  }

  /**
   * 算隔离档（只可收紧，语义同信任档）。
   * @param entry 待装条目
   * @returns 档位结论
   */
  private tightenIsolation(entry: PackAssetEntry): TierOutcome<IsolationLevel> {
    const base = this.defaults.isolation;
    const requested = entry.governance?.isolation;
    if (requested === undefined) return { ok: true, tier: base };
    if (ISOLATION_LEVEL_ORDER.indexOf(requested) < ISOLATION_LEVEL_ORDER.indexOf(base)) {
      return {
        ok: false,
        reason: `资产 ${entry.name} 的隔离档请求放宽（${base} → ${requested}）：只可收紧，整包拒`,
      };
    }
    return { ok: true, tier: requested };
  }

  /**
   * 入册（写入期意外抛错即补偿撤销本轮已入册者——账上不留假记录）。
   * @param prepared 待装条目
   * @returns 已入册资产名；失败时为可读原因
   */
  private register(prepared: readonly PreparedAsset[]): string[] | string {
    const installed: string[] = [];
    for (const item of prepared) {
      try {
        this.registry.put(AssetPackInstaller.recordOf(item, this.now()));
        installed.push(item.entry.name);
      } catch (err) {
        for (const name of installed) this.registry.remove(name);
        return `入册失败（${item.entry.name}）：${err instanceof Error ? err.message : String(err)}；已撤销本轮全部入册`;
      }
    }
    return installed;
  }

  /**
   * 入账：逐资产一条 `pack-install`（账上出现的每一条都对应一次真实入册）。
   * @param manifest 清单
   * @param prepared 待装条目
   * @param installed 已入册资产名
   * @returns 首条台账序号
   */
  private record(
    manifest: AssetPackManifest,
    prepared: readonly PreparedAsset[],
    installed: readonly string[],
  ): number | undefined {
    let first: number | undefined;
    for (const name of installed) {
      const item = prepared.find((p) => p.entry.name === name);
      const seq = this.ledger?.append({
        name,
        source: `pack:${manifest.name}@${manifest.publisher.runtimeId}${
          item === undefined ? '' : `/${item.trustTier}/${item.isolation}`
        }`,
        action: 'pack-install',
      });
      if (first === undefined) first = seq;
    }
    return first;
  }

  /**
   * 造一条资产记录（档位由预检算好；`ledgerSeq` 由入账后回填语义留空——记录是入册时刻的快照）。
   * @param item 预检结果
   * @param bornAt 出生时间
   * @returns 资产记录
   */
  private static recordOf(item: PreparedAsset, bornAt: string): CapabilityRecord {
    return {
      asset: item.entry.asset,
      schemaKind: item.entry.schemaKind,
      lineage: {
        parents: item.entry.parents ?? [],
        operator: item.entry.operator ?? 'pack:install',
        bornAt,
      },
      fitness: undefined,
      governance: {
        trustTier: item.trustTier,
        isolation: item.isolation,
        state: 'active',
        ledgerSeq: undefined,
      },
    };
  }

  /**
   * 取记录名（资产名；各类型 `validate` 已保证存在）。
   * @param record 资产记录
   * @returns 资产名
   */
  private static nameOf(record: CapabilityRecord): string {
    const name = (record.asset as { readonly name?: unknown }).name;
    return typeof name === 'string' ? name : '(anonymous)';
  }

  /**
   * 取两档中更严者。
   * @param order 档位全序
   * @param fallback 下限
   * @param requested 另一档（可缺省）
   * @returns 更严的档
   */
  private static stricter<T extends string>(
    order: readonly T[],
    fallback: T,
    requested: T | undefined,
  ): T {
    if (requested === undefined) return fallback;
    return order.indexOf(requested) > order.indexOf(fallback) ? requested : fallback;
  }

  /**
   * 造拒装报告（同一形状：`ok:false` + 可读原因）。
   * @param reason 原因
   * @returns 安装报告
   */
  private static reject(reason: string): InstallReport {
    return { ok: false, installed: [], rejectedReason: reason };
  }
}
