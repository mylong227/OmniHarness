/**
 * capability 子命令（Wave B/D · ADR-0009 / ADR-0011）：`list` / `metadata` / `install`。
 *
 * ## 只读与写操作分得很清
 *
 * - `list` / `metadata`：**结构性只读**——本类只拿到「取切片」的只读回调，
 *   没有注册表写入口、没有台账句柄，想写也写不了（Wave A 的 `evolution status` 同一形态）；
 * - `install`：写操作（入册 + 入账），**必须显式 `--yes`**；它经一个独立的安装器回调执行，
 *   而那个回调由命令链（`ExecCli`）在组合点构造（含台账装配）。
 *
 * ## install 的三条纪律（对应 ADR-0011）
 *
 * 1. 缺 `--yes` 即拒（退出码 2，零改动）；
 * 2. 默认严格档：无签名的包一律拒；`--allow-unsigned` 是**本地开发**用的显式降档
 *    （装入资产记 `external` 档，报告里如实标 `unsigned`）；
 * 3. 拒装必须给**可读原因**（安装器的 `rejectedReason` 原样透出，不退化成「失败」两个字）。
 *
 * ## 为什么需要这条出口
 *
 * 协议层最容易被问的是「现在注册了哪些类型、各有多少资产、默认档是什么、元数据长什么样」——
 * 没有只读出口，答案只能靠读代码猜。它也是 `capability.enabled` 的**接线证据**：
 * 关着的时候必须**如实报未启用**（退出码 1），而不是打一张空表让人以为「协议在跑但没资产」。
 *
 * @maturity L1 — 只读面 / 写操作门禁 / 未启用如实报错 / 拒装原因透出 判据钉死
 * @maturityEvidence tests/unit/capabilityCommand.test.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AssetPackPort, RegistryMetadata } from '../ports/asset.js';
import type { CapabilityStack } from '../ports/config/capabilityStack.js';
import { CliArgReader } from './cliArgReader.js';

/** 用法提示。 */
const USAGE =
  '用法: omniharness capability list [--json]\n' +
  '      omniharness capability metadata [--kind KIND] [--json]\n' +
  '      omniharness capability install <pack.ohb> --yes [--allow-unsigned]\n' +
  '说明: list / metadata 只读；install 会改动状态（入册 + 入账），必须显式 --yes。\n';

/**
 * 取资产协议切片（由命令链注入：`ExecCli` 用配置装载 + 装配得到它）。
 * @returns 切片；未启用（`capability.enabled !== true`）时为 undefined
 */
export type CapabilityStackProvider = () =>
  CapabilityStack | undefined | Promise<CapabilityStack | undefined>;

/**
 * 取资产包安装器（由命令链在组合点构造：含台账装配）。
 * @returns 安装器；未接线时为 undefined
 */
export type CapabilityInstallerProvider = () =>
  AssetPackPort | undefined | Promise<AssetPackPort | undefined>;

/** capability 子命令。 */
export class CapabilityCommand {
  /**
   * @param stackOf 切片提供者（只读回调）
   * @param installerOf 安装器提供者（写路径；缺省 = install 未接线，如实报用法错误）
   */
  public constructor(
    private readonly stackOf: CapabilityStackProvider,
    private readonly installerOf?: CapabilityInstallerProvider | undefined,
  ) {}

  /**
   * 执行 capability 子命令。
   * @param args 子命令参数（已去掉 `capability`，首元素为子命令名）
   * @returns 进程退出码（0 成功 / 1 未启用或拒装 / 2 用法错误）
   */
  public async run(args: readonly string[]): Promise<number> {
    const sub = args[0];
    if (sub === 'list') return this.list(args.slice(1));
    if (sub === 'metadata') return this.metadata(args.slice(1));
    if (sub === 'install') return this.install(args.slice(1));
    process.stdout.write(USAGE);
    return 2;
  }

  /**
   * `list`：列类型 / 资产数 / 生效档位（只读）。
   * @param args `list` 之后的旗标
   * @returns 退出码
   */
  private async list(args: readonly string[]): Promise<number> {
    const reader = new CliArgReader(args);
    const stack = await this.stackOf();
    if (stack === undefined) return CapabilityCommand.reportDisabled();
    const kinds = stack.schemas.kinds();
    const listing = kinds.map((kind) => {
      const schema = stack.schemas.schemaOf(kind);
      return {
        kind,
        version: schema.version,
        assets: stack.registry.recordsOfKind(kind).length,
        defaultTrustTier: schema.defaultTrustTier,
        defaultIsolation: schema.defaultIsolation,
      };
    });
    const summary = {
      kinds: listing,
      skills: stack.registry.list().length,
      defaults: stack.defaults,
    };
    process.stdout.write(
      reader.has('--json')
        ? `${JSON.stringify(summary)}\n`
        : `资产协议：${listing.length} 个类型 ｜ 技能表 ${summary.skills} 条\n` +
            listing
              .map(
                (entry) =>
                  `  ${entry.kind}（v${entry.version}）：资产 ${entry.assets} ｜ 默认档 ${entry.defaultTrustTier}/${entry.defaultIsolation}\n`,
              )
              .join('') +
            `  生效档位下限：${summary.defaults.trustTier}/${summary.defaults.isolation}\n`,
    );
    return 0;
  }

  /**
   * `metadata`：导出 MCP Registry 风格元数据（只读；不含资产内容）。
   * @param args `metadata` 之后的旗标
   * @returns 退出码（未知 kind 为 1）
   */
  private async metadata(args: readonly string[]): Promise<number> {
    const reader = new CliArgReader(args);
    const stack = await this.stackOf();
    if (stack === undefined) return CapabilityCommand.reportDisabled();
    const kind = reader.value('--kind');
    const kinds = kind === undefined ? stack.schemas.kinds() : [kind];
    const metadata = kinds
      .map((k) => CapabilityCommand.metadataOf(stack, k))
      .filter((entry): entry is RegistryMetadata => entry !== undefined);
    if (kind !== undefined && metadata.length === 0) {
      process.stderr.write(`类型未注册：${kind}\n`);
      return 1;
    }
    process.stdout.write(
      reader.has('--json')
        ? `${JSON.stringify(metadata)}\n`
        : metadata
            .map(
              (entry) =>
                `${entry.kind}（v${String(entry.version)}）：默认档 ${entry.defaultTrustTier}/${entry.defaultIsolation} ｜ 资产 ${entry.assets.length}\n` +
                entry.assets
                  .map(
                    (asset) =>
                      `  ${asset.name} ｜ ${asset.trustTier}/${asset.isolation} ｜ ${asset.state} ｜ ${asset.operator}\n`,
                  )
                  .join(''),
            )
            .join(''),
    );
    return 0;
  }

  /**
   * `install`：装签名资产包（写操作，需 `--yes`）。
   * @param args `install` 之后的旗标与包路径
   * @returns 退出码（缺 --yes / 缺路径为 2；拒装为 1）
   */
  private async install(args: readonly string[]): Promise<number> {
    const reader = new CliArgReader(args);
    const packPath = args.find((arg) => !arg.startsWith('--'));
    if (packPath === undefined) {
      process.stdout.write(USAGE);
      return 2;
    }
    if (!reader.has('--yes')) {
      process.stderr.write(
        `capability install ${packPath} 会改动状态（入册 + 入账），必须显式加 --yes。\n`,
      );
      return 2;
    }
    const installer = await this.installerOf?.();
    if (installer === undefined) {
      process.stderr.write('capability install 未接线（缺少安装器装配，或 capability 未启用）。\n');
      return 2;
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(resolve(packPath));
    } catch (err) {
      process.stderr.write(`无法读取资产包 ${packPath}：${String(err)}\n`);
      return 1;
    }
    const report = await installer.install({
      bytes,
      // `--allow-unsigned` 是**显式**降档（本地开发用）；缺省严格档（ADR-0011 决策 3）。
      ...(reader.has('--allow-unsigned') ? { requireSignature: false } : {}),
    });
    if (!report.ok) {
      process.stderr.write(`拒装：${report.rejectedReason ?? '未给原因'}\n`);
      return 1;
    }
    const fields = {
      ok: true,
      installed: report.installed.length,
      assets: report.installed,
      publisher: report.publisher?.runtimeId,
      ledgerSeq: report.ledgerSeq,
      ...(report.unsigned === true ? { unsigned: true } : {}),
    };
    process.stdout.write(
      reader.has('--json')
        ? `${JSON.stringify(fields)}\n`
        : `已安装 ${fields.installed} 条资产（发布者 ${String(fields.publisher)}）｜ 台账 seq=${String(fields.ledgerSeq)}\n` +
            report.installed.map((name) => `  ${name}\n`).join('') +
            (report.unsigned === true
              ? '  注意：本包未签名（--allow-unsigned），资产记 external 档。\n'
              : ''),
    );
    return 0;
  }

  /**
   * 取某类型的元数据（只读；仅公开字段——不含 instructions 明文）。
   * @param stack 切片
   * @param kind 类型键
   * @returns 元数据或 undefined（类型未注册）
   */
  private static metadataOf(stack: CapabilityStack, kind: string): RegistryMetadata | undefined {
    if (!stack.schemas.has(kind)) return undefined;
    const schema = stack.schemas.schemaOf(kind);
    return {
      kind,
      version: schema.version,
      defaultTrustTier: schema.defaultTrustTier,
      defaultIsolation: schema.defaultIsolation,
      assets: stack.registry.recordsOfKind(kind).map((record) => ({
        name: CapabilityCommand.nameOf(record.asset),
        trustTier: record.governance.trustTier,
        isolation: record.governance.isolation,
        state: record.governance.state,
        operator: record.lineage.operator,
      })),
    };
  }

  /**
   * 取资产名（各类型 `validate` 已保证存在；异常输入退回占位名，不抛）。
   * @param asset 资产本体
   * @returns 资产名
   */
  private static nameOf(asset: unknown): string {
    const name = (asset as { readonly name?: unknown } | null)?.name;
    return typeof name === 'string' ? name : '(anonymous)';
  }

  /**
   * 未启用时的如实申报（退出码 1；不打空表冒充「协议在跑」）。
   * @returns 退出码 1
   */
  private static reportDisabled(): number {
    process.stderr.write('capability 未启用（配置 `capability.enabled` 未开或未生效）。\n');
    return 1;
  }
}
