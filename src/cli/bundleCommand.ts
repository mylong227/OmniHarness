/**
 * bundle 子命令（BundleCommand）——把命名插件集打成自包含发布单元 `.ohb`，或还原。
 *
 * 从原 CliDataCmds 抽出，行为逐字节等价。
 * `pack` 把命名插件集及其插件源封进 `.ohb`（零依赖 zip + 可选 HMAC 签名）；
 * `unpack` 还原插件到 pluginsDir 并写出补丁层（config 覆盖），使「用户覆盖层叠在 base 之上」真正可用。
 * `createRegistry` 由命令继承链以工厂函数注入，从而本类不依赖继承链。
 *
 * 用法: omniharness bundle pack <profileName> [--key-file K] [--out-dir D] [--dir P] | unpack <path.ohb> [--key-file K] [--dir P]
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { PluginProfileStore, sanitizeProfileName } from '../plugin/pluginProfileStore.js';
import { packBundle, unpackBundle } from '../plugin/pluginBundler.js';
import { messageOf } from './argParser.js';
import { CliArgReader } from './cliArgReader.js';
import type { PluginRegistryFactory } from './pluginCommand.js';

/** bundle 用法提示。 */
const USAGE =
  '用法: omniharness bundle pack <profileName> [--key-file K] [--out-dir D] [--dir P] | bundle unpack <path.ohb> [--key-file K] [--dir P]\n';

export class BundleCommand {
  private readonly createRegistry: PluginRegistryFactory;

  /**
   * @param createRegistry 注册表工厂（打包时用于解析插件源）。
   */
  public constructor(createRegistry: PluginRegistryFactory) {
    this.createRegistry = createRegistry;
  }

  /**
   * 执行 bundle 子命令（pack / unpack）。
   * @param args 子命令参数（已去掉 `bundle`）。
   * @returns 进程退出码。
   */
  public async runBundle(args: readonly string[]): Promise<number> {
    const sub = args[0];
    const reader = new CliArgReader(args);
    const wsRoot = reader.value('--workspace') ?? process.cwd();
    const pluginsDir = reader.value('--dir') ?? join(homedir(), '.omniharness', 'plugins');
    if (sub === 'pack') {
      return this.pack(args, reader, wsRoot, pluginsDir);
    }
    if (sub === 'unpack') {
      return this.unpack(reader, wsRoot, pluginsDir);
    }
    process.stdout.write(USAGE);
    return 2;
  }

  /**
   * bundle pack：把命名插件集及其插件源封进 `.ohb`（可选 HMAC 签名）。
   * @param args 子命令参数。
   * @param reader 参数读取器（位置参数 1 为 profile 名）。
   * @param wsRoot 工作区根。
   * @param pluginsDir 插件安装目录。
   * @returns 退出码（0 成功 / 1 失败 / 2 用法错误）。
   */
  private async pack(
    args: readonly string[],
    reader: CliArgReader,
    wsRoot: string,
    pluginsDir: string,
  ): Promise<number> {
    const name = reader.at(1);
    if (name === undefined) {
      process.stdout.write(
        '用法: omniharness bundle pack <profileName> [--key-file K] [--out-dir D] [--dir P]\n',
      );
      return 2;
    }
    const store = new PluginProfileStore(wsRoot);
    const profile = store.get(sanitizeProfileName(name));
    if (profile === undefined) {
      process.stderr.write(`未找到插件集 profile: ${name}\n`);
      return 1;
    }
    const registry = this.createRegistry(args, pluginsDir);
    const keyFile = reader.value('--key-file');
    const outDir = reader.value('--out-dir');
    try {
      const result = await packBundle({
        workspaceDir: wsRoot,
        profile,
        registry,
        pluginsDir,
        ...(keyFile !== undefined ? { keyFile } : {}),
        ...(outDir !== undefined ? { outDir } : {}),
      });
      process.stdout.write(
        `已打包 bundle: ${result.path}（${result.manifest.plugins.length} 插件${result.manifest.signature !== undefined ? '，已签名' : ''}）\n`,
      );
      return 0;
    } catch (error) {
      console.error(`打包失败: ${messageOf(error)}`);
      return 1;
    }
  }

  /**
   * bundle unpack：还原插件到 pluginsDir 并写出补丁层（config 覆盖）。
   * @param reader 参数读取器（位置参数 1 为 `.ohb` 路径）。
   * @param wsRoot 工作区根。
   * @param pluginsDir 插件安装目录。
   * @returns 退出码（0 成功 / 1 失败 / 2 用法错误）。
   */
  private async unpack(
    reader: CliArgReader,
    wsRoot: string,
    pluginsDir: string,
  ): Promise<number> {
    const path = reader.at(1);
    if (path === undefined) {
      process.stdout.write('用法: omniharness bundle unpack <path.ohb> [--key-file K] [--dir P]\n');
      return 2;
    }
    const keyFile = reader.value('--key-file');
    try {
      const result = await unpackBundle({
        zipPath: path,
        pluginsDir,
        workspaceDir: wsRoot,
        ...(keyFile !== undefined ? { keyFile } : {}),
      });
      process.stdout.write(
        `已解包 bundle: ${result.manifest.name}（还原 ${result.installed.length} 插件，补丁层 ${result.patchFile}）\n`,
      );
      return 0;
    } catch (error) {
      console.error(`解包失败: ${messageOf(error)}`);
      return 1;
    }
  }
}
