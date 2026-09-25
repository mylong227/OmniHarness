/**
 * profile 子命令（ProfileCommand）——命名插件集（Profile）的增删查用。
 *
 * 从原 CliDataCmds 抽出，行为逐字节等价。`use` 把激活的 profile 名持久化到工作区配置，
 * 使后续 `serve` 默认收敛为该插件集。本类不依赖命令继承链，可独立测试。
 *
 * 用法: omniharness profile list | create <name> [--desc D] [--plugin P ...] | delete <name> | use <name>
 */

import { join } from 'node:path';
import { configFile } from '../config/configFile.js';
import { PluginProfileStore } from '../plugin/pluginProfileStore.js';
import { CliArgReader } from './cliArgReader.js';

/** profile 用法提示。 */
const USAGE =
  '用法: omniharness profile list | profile create <name> [--desc D] [--plugin P ...] | profile delete <name> | profile use <name>\n';

export class ProfileCommand {
  /**
   * 执行 profile 子命令（list / create / delete / use）。
   * @param args 子命令参数（已去掉 `profile`）。
   * @returns 进程退出码。
   */
  public async runProfile(args: readonly string[]): Promise<number> {
    const sub = args[0];
    const reader = new CliArgReader(args);
    const wsRoot = reader.value('--workspace') ?? process.cwd();
    const store = new PluginProfileStore(wsRoot);
    if (sub === 'list') {
      return this.list(store);
    }
    if (sub === 'create') {
      return this.create(store, reader);
    }
    if (sub === 'delete') {
      return this.delete(store, reader);
    }
    if (sub === 'use') {
      return this.use(store, wsRoot, reader);
    }
    process.stdout.write(USAGE);
    return 2;
  }

  /**
   * 列出全部插件集 Profile。
   * @param store Profile 存储。
   * @returns 退出码（恒 0）。
   */
  private list(store: PluginProfileStore): number {
    const all = store.list();
    if (all.length === 0) {
      process.stdout.write(
        '（无插件集 profile；用 profile create <name> --plugin P1 --plugin P2 创建）\n',
      );
      return 0;
    }
    for (const p of all) {
      process.stdout.write(
        `${p.name}\t${p.pluginCount} 插件${p.description !== undefined ? '\t' + p.description : ''}\n`,
      );
    }
    return 0;
  }

  /**
   * 创建命名插件集。
   * @param store Profile 存储。
   * @param reader 参数读取器（位置参数 1 为名称）。
   * @returns 退出码（0 成功 / 2 用法错误）。
   */
  private create(store: PluginProfileStore, reader: CliArgReader): number {
    const name = reader.at(1);
    if (name === undefined) {
      process.stdout.write('用法: omniharness profile create <name> [--desc D] [--plugin P ...]\n');
      return 2;
    }
    const plugins = reader.values('--plugin');
    const desc = reader.value('--desc');
    const id = store.save({
      name,
      plugins,
      ...(desc !== undefined ? { description: desc } : {}),
    });
    process.stdout.write(`已创建插件集 profile: ${name} (id=${id}, ${plugins.length} 插件)\n`);
    return 0;
  }

  /**
   * 删除命名插件集。
   * @param store Profile 存储。
   * @param reader 参数读取器（位置参数 1 为名称）。
   * @returns 退出码（0 已删 / 1 未找到 / 2 用法错误）。
   */
  private delete(store: PluginProfileStore, reader: CliArgReader): number {
    const name = reader.at(1);
    if (name === undefined) {
      process.stdout.write('用法: omniharness profile delete <name>\n');
      return 2;
    }
    const removed = store.delete(PluginProfileStore.sanitizeProfileName(name));
    process.stdout.write(
      removed ? `已删除插件集 profile: ${name}\n` : `（未找到 profile: ${name}）\n`,
    );
    return removed ? 0 : 1;
  }

  /**
   * 激活插件集并持久化到工作区配置（使后续 serve 默认应用）。
   * @param store Profile 存储。
   * @param wsRoot 工作区根。
   * @param reader 参数读取器（位置参数 1 为名称）。
   * @returns 退出码（0 成功 / 1 未找到 / 2 用法错误）。
   */
  private use(store: PluginProfileStore, wsRoot: string, reader: CliArgReader): number {
    const name = reader.at(1);
    if (name === undefined) {
      process.stdout.write('用法: omniharness profile use <name>\n');
      return 2;
    }
    const id = PluginProfileStore.sanitizeProfileName(name);
    const profile = store.get(id);
    if (profile === undefined) {
      process.stderr.write(`未找到插件集 profile: ${name}\n`);
      return 1;
    }
    // 持久化到工作区配置，使后续 serve 默认应用该 profile（serve 读 config.pluginProfile 兜底）。
    const configPath = configFile.find(wsRoot) ?? join(wsRoot, configFile.FILE_NAME);
    const loaded = configFile.load(configPath);
    configFile.save(configPath, { ...loaded, pluginProfile: id });
    process.stdout.write(
      `已激活插件集 profile: ${name}（已写入 ${configPath}，下次 serve 将自动应用）\n`,
    );
    return 0;
  }
}
