/**
 * cliDataCmds.ts —— ExecCli 命令簇（god-class 拆分 · 数据/存储/插件层）。
 *
 * 本层只做**子命令分发**：把 session / plugin / profile / bundle / audit / kv / vault 各自委派给
 * 单一职责的命令协作者（各有专属文件、文件名=类名）：
 *   - `SessionCommand`（session list）
 *   - `PluginCommand`（plugin load/list/search/install/remove）
 *   - `ProfileCommand`（profile list/create/delete/use）
 *   - `BundleCommand`（bundle pack/unpack）
 *   - `AuditCommand`（audit export / 合规报告）
 *   - `StoreCommand`（kv / vault —— 本地键值与凭据）
 * 协作者通过 `CliArgReader` 组合式取参，所需的注册表工厂由本类注入，
 * 从而协作者不依赖命令继承链，可独立测试。方法签名与退出码保持与原实现一致，`execImpl` 分发点零改动。
 */

import { CliMcpCmds } from './cliMcpCmds.js';
import { SessionCommand } from './sessionCommand.js';
import { PluginCommand } from './pluginCommand.js';
import { ProfileCommand } from './profileCommand.js';
import { LicenseSource } from '../license/licenseSource.js';
import { BundleCommand } from './bundleCommand.js';
import { AuditCommand } from './auditCommand.js';
import { StoreCommand } from './storeCommand.js';
import { TraceCommand } from './traceCommand.js';
import { SdkCommand } from './sdkCommand.js';
import { BoostCommand, BOOST_PROBE_TIMEOUT_MS, type BoostOptions } from './boostCommand.js';
import { CliArgReader } from './cliArgReader.js';

/** 数据 / 存储 / 插件类子命令（薄分发门面）。 */
export class CliDataCmds extends CliMcpCmds {
  /** session 子命令（session list）。 */
  private readonly sessionCommand = new SessionCommand();
  /** plugin 子命令（load/list/search/install/remove）。 */
  private readonly pluginCommand = new PluginCommand((args, pluginsDir) =>
    this.createRegistry(args, pluginsDir),
  );
  /** profile 子命令（list/create/delete/use）。 */
  private readonly profileCommand = new ProfileCommand();
  /** bundle 子命令（pack/unpack）。 */
  private readonly bundleCommand = new BundleCommand(
    (args, pluginsDir) => this.createRegistry(args, pluginsDir),
    // (F4) 功能权益来自本机授权（`OMNI_LICENSE*` 环境变量）；没有授权就是 core 档，
    // 私有源等 Team 能力**如实拒绝**并给出可读拒因——闸门必须反映真实档位，不给隐式全开。
    LicenseSource.resolve({ env: process.env }),
  );
  /** audit 子命令（导出 / 合规报告）。 */
  private readonly auditCommand = new AuditCommand();
  /** kv / vault 子命令（本地键值与凭据）。 */
  private readonly storeCommand = new StoreCommand();
  /** trace 子命令（只读自省会话事件流）。 */
  private readonly traceCommand = new TraceCommand();
  /** sdk 子命令（连 app-server WS 端点发 JSON-RPC）。 */
  private readonly sdkCommand = new SdkCommand();
  /** boost 子命令（探针归档比对 / 按改动挑门禁子集；只读外部脚本，不改它们）。 */
  private readonly boostCommand = new BoostCommand(process.cwd());

  /**
   * session 子命令入口。
   * @param args 子命令参数（已去掉 `session`）。
   * @returns 进程退出码。
   */
  protected async runSession(args: readonly string[]): Promise<number> {
    return this.sessionCommand.run(args);
  }

  /**
   * plugin 子命令入口。
   * @param args 子命令参数（已去掉 `plugin`）。
   * @returns 进程退出码。
   */
  protected async runPlugin(args: readonly string[]): Promise<number> {
    return this.pluginCommand.runPlugin(args);
  }

  /**
   * profile 子命令入口。
   * @param args 子命令参数（已去掉 `profile`）。
   * @returns 进程退出码。
   */
  protected async runProfile(args: readonly string[]): Promise<number> {
    return this.profileCommand.runProfile(args);
  }

  /**
   * bundle 子命令入口。
   * @param args 子命令参数（已去掉 `bundle`）。
   * @returns 进程退出码。
   */
  protected async runBundle(args: readonly string[]): Promise<number> {
    return this.bundleCommand.runBundle(args);
  }

  /**
   * audit 子命令入口。
   * @param args 子命令参数（已去掉 `audit`）。
   * @returns 进程退出码。
   */
  protected async runAudit(args: readonly string[]): Promise<number> {
    return this.auditCommand.run(args);
  }

  /**
   * kv 子命令入口。
   * @param args 子命令参数（已去掉 `kv`）。
   * @returns 进程退出码。
   */
  protected async runKv(args: readonly string[]): Promise<number> {
    return this.storeCommand.runKv(args);
  }

  /**
   * vault 子命令入口。
   * @param args 子命令参数（已去掉 `vault`）。
   * @returns 进程退出码。
   */
  protected async runVault(args: readonly string[]): Promise<number> {
    return this.storeCommand.runVault(args);
  }

  /**
   * trace 子命令入口（只读自省：`trace read --session ID`）。
   * @param args 子命令参数（已去掉 `trace`）。
   * @returns 进程退出码。
   */
  protected async runTrace(args: readonly string[]): Promise<number> {
    return this.traceCommand.run(args);
  }

  /**
   * sdk 子命令入口（`sdk call --url ws://... --method NAME`）。
   * @param args 子命令参数（已去掉 `sdk`）。
   * @returns 进程退出码。
   */
  protected async runSdk(args: readonly string[]): Promise<number> {
    return this.sdkCommand.run(args);
  }

  /**
   * boost 子命令入口（`boost probe …` / `boost gate …`）。
   *
   * 旗标在本层用 `CliArgReader` **字面量读取**，命令类只收一个已解析的选项对象：
   * 这样做的直接理由是本仓的 `tests/unit/knownFlags.test.ts` 判据③——登记进 `KNOWN_EXTRA_FLAGS`
   * 的旗标必须在 `src/cli/**` 里被真实读取，否则判"白名单腐化"。把读取放在本层，
   * "登记了、也有人读"这件事就在同一处可核。
   * @param args 子命令参数（已去掉 `boost`）。
   * @returns 进程退出码（由命令类决定；用法错误 2）。
   */
  protected async runBoost(args: readonly string[]): Promise<number> {
    const options = this.readBoostOptions(args);
    if (options === null) {
      process.stderr.write(
        '用法: omniharness boost probe [list] [--boost-probe NAME] [--boost-arg VALUE] [--boost-network]\n' +
          '      [--boost-diff] [--boost-dir DIR] [--boost-timeout-ms N]\n' +
          '       omniharness boost gate [--boost-mode staged|worktree] [--boost-tier fast|typed|all]\n' +
          '      [--boost-run] [--boost-explain] [--boost-dir DIR]\n' +
          '       omniharness boost audit-surface [--boost-run] [--boost-dir DIR]\n',
      );
      return 2;
    }
    return this.boostCommand.run(options);
  }

  /**
   * 读取 boost 子命令旗标（值旗标一律 `--flag VALUE` 两 token 形式，与全仓其它子命令一致）。
   * @param args 子命令参数（已去掉 `boost`）。
   * @returns 选项对象；用法错误（未知子动作 / 非法取值）返回 `null`。
   */
  private readBoostOptions(args: readonly string[]): BoostOptions | null {
    const reader = new CliArgReader(args);
    const action = reader.at(0) ?? 'probe';
    if (action !== 'probe' && action !== 'gate' && action !== 'audit-surface') return null;
    const tier = reader.value('--boost-tier') ?? 'fast';
    if (!['fast', 'typed', 'all'].includes(tier)) return null;
    const mode = reader.value('--boost-mode') ?? 'staged';
    if (mode !== 'staged' && mode !== 'worktree') return null;
    const timeout = reader.number('--boost-timeout-ms');
    const boostDir = reader.value('--boost-dir');
    const probes = this.splitCsv(reader.value('--boost-probe'));
    return {
      action,
      list: reader.has('--boost-list'),
      probes,
      args: reader.values('--boost-arg'),
      network: reader.has('--boost-network'),
      diff: reader.has('--boost-diff'),
      tier,
      mode,
      run: reader.has('--boost-run'),
      explain: reader.has('--boost-explain'),
      ...(boostDir === undefined ? {} : { outDir: boostDir }),
      timeoutMs:
        timeout === undefined || !Number.isFinite(timeout) ? BOOST_PROBE_TIMEOUT_MS : timeout,
    };
  }

  /**
   * 逗号分隔取值切分（去空、去重、保序）。
   * @param raw 原始取值；缺省返回空数组。
   * @returns 切分结果。
   */
  private splitCsv(raw: string | undefined): readonly string[] {
    if (raw === undefined) return [];
    return [
      ...new Set(
        raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== ''),
      ),
    ];
  }
}
