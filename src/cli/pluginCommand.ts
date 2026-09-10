/**
 * plugin 子命令（PluginCommand）——插件生态的发现 / 安装 / 加载 / 移除。
 *
 * 从原 CliDataCmds 抽出，行为逐字节等价。`createRegistry` 由命令继承链以工厂函数注入，
 * 从而本类不依赖继承链，可独立测试。
 *
 * 用法: omniharness plugin load --file PATH [--allow PERM ...] [--allow-all] | list | search [QUERY] | install <name> | remove <name>
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Container } from '../core/container.js';
import { PluginManager } from '../plugin/pluginManager.js';
import { manifestHasDangerous } from '../plugin/manifest.js';
import { PermissionGate, PermissionDeniedError } from '../plugin/permissionGate.js';
import { isPluginPermission } from '../plugin/permission.js';
import type { PluginPermission } from '../plugin/permission.js';
import type { Plugin } from '../plugin/plugin.js';
import type { PluginRegistry } from '../plugin/registry.js';
import { messageOf } from './args.js';
import { CliArgReader } from './cliArgReader.js';

/** 构造插件注册表的工厂（由命令继承链注入，避免命令类依赖继承链）。 */
export type PluginRegistryFactory = (args: readonly string[], pluginsDir?: string) => PluginRegistry;

/** plugin 用法提示。 */
const USAGE =
  '用法: omniharness plugin load --file PATH [--allow PERM ...] | plugin list | plugin search [QUERY] | plugin install <name> | plugin remove <name>\n';

export class PluginCommand {
  private readonly createRegistry: PluginRegistryFactory;

  /**
   * @param createRegistry 注册表工厂（通常为 CliBuildConfig.createRegistry 的绑定包装）。
   */
  public constructor(createRegistry: PluginRegistryFactory) {
    this.createRegistry = createRegistry;
  }

  /**
   * 执行 plugin 子命令（load / list / search / install / remove）。
   * @param args 子命令参数（已去掉 `plugin`，首元素为子命令名）。
   * @returns 进程退出码。
   */
  public async runPlugin(args: readonly string[]): Promise<number> {
    const sub = args[0];
    const reader = new CliArgReader(args);
    if (sub === 'load') {
      return this.pluginLoad(args, reader);
    }
    if (sub === 'list') {
      return this.pluginList(args);
    }
    if (sub === 'search') {
      return this.pluginSearch(args, reader);
    }
    if (sub === 'install') {
      return this.pluginInstall(args, reader);
    }
    if (sub === 'remove') {
      return this.pluginRemove(args, reader);
    }
    process.stdout.write(USAGE);
    return 2;
  }

  /**
   * plugin load：从文件动态导入并注册插件（受 PermissionGate 约束）。
   * @param args 子命令参数（读取 `--allow-all`）。
   * @param reader 参数读取器。
   * @returns 退出码（0 成功 / 1 权限拒绝 / 2 用法或未知权限）。
   */
  private async pluginLoad(args: readonly string[], reader: CliArgReader): Promise<number> {
    const file = reader.value('--file');
    if (file === undefined) {
      process.stdout.write(
        '用法: omniharness plugin load --file PATH [--allow PERM ...] [--allow-all]\n',
      );
      return 2;
    }
    const allowAll = args.includes('--allow-all');
    const allowed = reader.values('--allow');
    for (const permission of allowed) {
      if (!isPluginPermission(permission)) {
        process.stdout.write(`未知权限: ${permission}（合法项见 ALL_PERMISSIONS）\n`);
        return 2;
      }
    }
    const gate = allowAll
      ? PermissionGate.allowAll()
      : PermissionGate.fromList(allowed as PluginPermission[]);
    const module = await import(pathToFileURL(resolve(file)).href);
    const plugin = module.default as { meta?: { name?: string } };
    const manager = new PluginManager(new Container(), gate);
    try {
      await manager.register(plugin as Plugin);
    } catch (error) {
      if (error instanceof PermissionDeniedError) {
        console.error(`${error.message}`);
        return 1;
      }
      throw error;
    }
    process.stdout.write(`插件加载: ${plugin.meta?.name ?? file}\n`);
    return 0;
  }

  /**
   * plugin list：列出已安装插件（危险权限标注）。
   * @param args 子命令参数（供注册表工厂读取 `--dir` / `--catalog`）。
   * @returns 退出码（恒 0）。
   */
  private async pluginList(args: readonly string[]): Promise<number> {
    const installed = await this.createRegistry(args).list();
    if (installed.length === 0) {
      process.stdout.write('（无已安装插件；用 plugin search 发现，plugin install <name> 安装）\n');
      return 0;
    }
    for (const manifest of installed) {
      const flag = manifestHasDangerous(manifest) ? '  [危险权限]' : '';
      process.stdout.write(
        `${manifest.name}@${manifest.version}\t${manifest.description ?? ''}${flag}\n`,
      );
    }
    return 0;
  }

  /**
   * plugin search：在注册表中搜索插件。
   * @param args 子命令参数。
   * @param reader 参数读取器（`--query` 或位置参数）。
   * @returns 退出码（恒 0）。
   */
  private async pluginSearch(args: readonly string[], reader: CliArgReader): Promise<number> {
    const query = reader.value('--query') ?? reader.at(1);
    const results = await this.createRegistry(args).search(query);
    if (results.length === 0) {
      process.stdout.write('（无匹配插件）\n');
      return 0;
    }
    for (const descriptor of results) {
      const flag = manifestHasDangerous(descriptor.manifest) ? '  [危险权限]' : '';
      process.stdout.write(
        `[${descriptor.source}]\t${descriptor.manifest.name}@${descriptor.manifest.version}\t${descriptor.manifest.description ?? ''}${flag}\n`,
      );
    }
    return 0;
  }

  /**
   * plugin install：安装指定插件。
   * @param args 子命令参数。
   * @param reader 参数读取器（位置参数 1 为插件名）。
   * @returns 退出码（0 成功 / 1 失败 / 2 用法错误）。
   */
  private async pluginInstall(args: readonly string[], reader: CliArgReader): Promise<number> {
    const name = reader.at(1);
    if (name === undefined) {
      process.stdout.write('用法: omniharness plugin install <name> [--dir DIR]\n');
      return 2;
    }
    try {
      const manifest = await this.createRegistry(args).install(name);
      const warn = manifestHasDangerous(manifest)
        ? '\n注意: 该插件声明危险权限，加载时将被 PermissionGate 拦截，除非显式 --allow 放行。'
        : '';
      process.stdout.write(`已安装插件: ${manifest.name}@${manifest.version}${warn}\n`);
      return 0;
    } catch (error) {
      console.error(`安装失败: ${messageOf(error)}`);
      return 1;
    }
  }

  /**
   * plugin remove：移除指定插件。
   * @param args 子命令参数。
   * @param reader 参数读取器（位置参数 1 为插件名）。
   * @returns 退出码（0 成功 / 1 失败 / 2 用法错误）。
   */
  private async pluginRemove(args: readonly string[], reader: CliArgReader): Promise<number> {
    const name = reader.at(1);
    if (name === undefined) {
      process.stdout.write('用法: omniharness plugin remove <name> [--dir DIR]\n');
      return 2;
    }
    try {
      await this.createRegistry(args).remove(name);
      process.stdout.write(`已移除插件: ${name}\n`);
      return 0;
    } catch (error) {
      console.error(`移除失败: ${messageOf(error)}`);
      return 1;
    }
  }
}
