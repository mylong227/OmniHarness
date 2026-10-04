/**
 * bundle 子命令（BundleCommand）——把命名插件集打成自包含发布单元 `.ohb`，或还原。
 *
 * 从原 CliDataCmds 抽出，行为逐字节等价。
 * `pack` 把命名插件集及其插件源封进 `.ohb`（无第三方依赖 zip + 可选 HMAC 签名）；
 * `unpack` 还原插件到 pluginsDir 并写出补丁层（config 覆盖），使「用户覆盖层叠在 base 之上」真正可用。
 * `createRegistry` 由命令继承链以工厂函数注入，从而本类不依赖继承链。
 *
 * 用法: omniharness bundle pack <profileName> [--key-file K] [--out-dir D] [--dir P] | unpack <path.ohb> [--key-file K] [--dir P]
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { PluginProfileStore } from '../plugin/pluginProfileStore.js';
import { PluginBundler } from '../plugin/pluginBundler.js';
import { PrivateSkillSource } from '../plugin/privateSkillSource.js';
import { ArgParser } from './argParser.js';
import { CliArgReader } from './cliArgReader.js';
import type { PluginRegistryFactory } from './pluginCommand.js';

/** bundle 用法提示。 */
const USAGE =
  '用法: omniharness bundle pack <profileName> [--key-file K] [--out-dir D] [--dir P] | bundle unpack <path.ohb> [--key-file K] [--dir P] | bundle source list|sync --source DIR --trust KEY [--loose]\n';

/** `bundle source` 用法提示（G2 私有技能源）。 */
const SOURCE_USAGE =
  '用法: omniharness bundle source list|sync --source DIR --trust <ssh-ed25519 …> [--trust …] [--loose]\n' +
  '说明: 缺省严格档——无 Ed25519 签名的包一律拒；--loose 才收无签名包（标注 community）。\n';

export class BundleCommand {
  /** 注入的注册表工厂（打包时用于解析插件源）。 */
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
    if (sub === 'source') {
      return this.source(reader, wsRoot, pluginsDir);
    }
    process.stdout.write(USAGE);
    return 2;
  }

  /**
   * `bundle source`：团队**私有技能源**的枚举与同步（G2）。
   *
   * 用法：
   * - `bundle source list --source DIR --trust <ssh-ed25519 …> [--trust …] [--loose]`
   * - `bundle source sync --source DIR --trust … [--loose]`
   *
   * 严格档（缺省）下**无签名包一律拒**（G2 判据）；`--loose` 才收无签名包，但报告里标注 `community`
   * ——档位如实呈现，不静默提档。安装动作复用既有的 `unpackBundle`（不另写一条安装链路）。
   * @param args 子命令参数（位置参数 2 为 `list` / `sync`）
   * @param reader 参数读取器
   * @param wsRoot 工作区根
   * @param pluginsDir 插件安装目录
   * @returns 退出码（0 = 全部放行或 list 成功；1 = 存在被拒包；2 = 用法错误）
   */
  private async source(reader: CliArgReader, wsRoot: string, pluginsDir: string): Promise<number> {
    const action = reader.at(1); // args = ['source', <action>, ...]
    const sourceDir = reader.value('--source');
    const trust = reader.values('--trust');
    if (action !== 'list' && action !== 'sync') {
      process.stdout.write(SOURCE_USAGE);
      return 2;
    }
    if (sourceDir === undefined) {
      process.stdout.write(SOURCE_USAGE);
      return 2;
    }
    const strict = !reader.has('--loose');
    const skillSource = new PrivateSkillSource({
      sourceDir,
      strict,
      trustedPublicKeys: trust,
      install: async (request) => {
        await PluginBundler.unpackBundle({
          zipPath: request.path,
          pluginsDir,
          workspaceDir: wsRoot,
        });
      },
    });
    if (action === 'list') {
      const entries = skillSource.list();
      for (const entry of entries) {
        const mark = entry.accepted ? '✓' : '✗';
        const tier = entry.tier === 'verified' ? 'verified' : 'community';
        process.stdout.write(
          `${mark} ${entry.name}@${entry.version}（${tier}，签名=${entry.signatureKind}）` +
            `${entry.reason === undefined ? '' : `：${entry.reason}`}\n`,
        );
      }
      process.stdout.write(
        `源 ${sourceDir}：${String(entries.length)} 个包，放行 ${String(entries.filter((e) => e.accepted).length)} 个（档位：${strict ? '严格' : '宽松'}）\n`,
      );
      return entries.every((e) => e.accepted) ? 0 : 1;
    }
    const report = await skillSource.sync();
    process.stdout.write(
      `已安装 ${String(report.installed.length)} 个：${report.installed.join(', ')}\n`,
    );
    if (report.refused.length > 0) {
      process.stderr.write(
        `被拒 ${String(report.refused.length)} 个：${report.refused.join(', ')}\n`,
      );
      for (const entry of report.entries.filter((e) => !e.accepted)) {
        process.stderr.write(`  - ${entry.name}：${entry.reason ?? '未说明'}\n`);
      }
      return 1;
    }
    return 0;
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
    const profile = store.get(PluginProfileStore.sanitizeProfileName(name));
    if (profile === undefined) {
      process.stderr.write(`未找到插件集 profile: ${name}\n`);
      return 1;
    }
    const registry = this.createRegistry(args, pluginsDir);
    const keyFile = reader.value('--key-file');
    const outDir = reader.value('--out-dir');
    try {
      const result = await PluginBundler.packBundle({
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
      console.error(`打包失败: ${ArgParser.messageOf(error)}`);
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
  private async unpack(reader: CliArgReader, wsRoot: string, pluginsDir: string): Promise<number> {
    const path = reader.at(1);
    if (path === undefined) {
      process.stdout.write('用法: omniharness bundle unpack <path.ohb> [--key-file K] [--dir P]\n');
      return 2;
    }
    const keyFile = reader.value('--key-file');
    try {
      const result = await PluginBundler.unpackBundle({
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
      console.error(`解包失败: ${ArgParser.messageOf(error)}`);
      return 1;
    }
  }
}
