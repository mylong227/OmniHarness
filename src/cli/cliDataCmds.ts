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
import { BundleCommand } from './bundleCommand.js';
import { AuditCommand } from './auditCommand.js';
import { StoreCommand } from './storeCommand.js';
import { TraceCommand } from './traceCommand.js';
import { SdkCommand } from './sdkCommand.js';

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
  private readonly bundleCommand = new BundleCommand((args, pluginsDir) =>
    this.createRegistry(args, pluginsDir),
  );
  /** audit 子命令（导出 / 合规报告）。 */
  private readonly auditCommand = new AuditCommand();
  /** kv / vault 子命令（本地键值与凭据）。 */
  private readonly storeCommand = new StoreCommand();
  /** trace 子命令（只读自省会话事件流）。 */
  private readonly traceCommand = new TraceCommand();
  /** sdk 子命令（连 app-server WS 端点发 JSON-RPC）。 */
  private readonly sdkCommand = new SdkCommand();

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
}
