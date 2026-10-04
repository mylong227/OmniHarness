/**
 * capability 子命令（Wave B · ADR-0009）：`omniharness capability list`。
 *
 * ## 只读（结构性保证，不靠自觉）
 *
 * 本类**只持有**一个「取切片」的只读回调（`CapabilityStackProvider`），从头到尾没有拿到
 * `put` / `setGovernance` 的写入口，也没有台账句柄——所以「看一眼资产」不可能有副作用，
 * 这是类型层面的约束而不是纪律约束（Wave A 的 `evolution status` 同一形态）。
 *
 * ## 为什么需要它（而不是「有 API 就够了」）
 *
 * 协议层最容易被问的问题是「现在到底注册了哪些类型、各有多少资产、默认档是什么」——
 * 没有这条只读出口，答案只能靠读代码猜。它也是 `capability.enabled` 的**接线证据**：
 * 关着的时候必须**如实报未启用**（退出码 1），而不是打印一张空表让人以为「协议在跑但没资产」。
 *
 * @maturity L1 — 只读面/未启用如实报错/输出确定性判据钉死
 * @maturityEvidence tests/unit/capabilityCommand.test.ts
 */
import type { CapabilityStack } from '../ports/config/capabilityStack.js';
import { CliArgReader } from './cliArgReader.js';

/** 用法提示。 */
const USAGE =
  '用法: omniharness capability list [--json]\n说明: 只读（列类型 / 资产数 / 生效档位）。\n';

/**
 * 取资产协议切片（由命令链注入：`ExecCli` 用配置装载 + 装配得到它）。
 * @returns 切片；未启用（`capability.enabled !== true`）时为 undefined
 */
export type CapabilityStackProvider = () =>
  CapabilityStack | undefined | Promise<CapabilityStack | undefined>;

/** capability 子命令：目前只有只读的 `list`。 */
export class CapabilityCommand {
  /**
   * @param stackOf 切片提供者（只读回调；本类没有写入口）
   */
  public constructor(private readonly stackOf: CapabilityStackProvider) {}

  /**
   * 执行 capability 子命令。
   * @param args 子命令参数（已去掉 `capability`，首元素为子命令名）
   * @returns 进程退出码（0 成功 / 1 未启用 / 2 用法错误）
   */
  public async run(args: readonly string[]): Promise<number> {
    if (args[0] !== 'list') {
      process.stdout.write(USAGE);
      return 2;
    }
    const reader = new CliArgReader(args.slice(1));
    const json = reader.has('--json');
    const stack = await this.stackOf();
    if (stack === undefined) {
      process.stderr.write(
        'capability 未启用（配置 `capability.enabled` 未开或未生效），无资产可列。\n',
      );
      return 1;
    }
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
      json
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
}
