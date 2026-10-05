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
import { BundleCodec } from '../plugin/bundleCodec.js';
import { PackGrader } from '../plugin/packGrader.js';
import { IsolationLadderFactory } from '../adapters/isolation/isolationLadderFactory.js';
import { ArgParser } from './argParser.js';
import { CliArgReader } from './cliArgReader.js';
import type { PackCapability } from '../plugin/packStaticScanner.js';
import type { SandboxLegVerdict } from '../plugin/packGrader.js';
import type { PluginRegistryFactory } from './pluginCommand.js';

/** bundle 用法提示。 */
const USAGE =
  '用法: omniharness bundle pack <profileName> [--key-file K] [--out-dir D] [--dir P] | bundle unpack <path.ohb> [--key-file K] [--dir P] | bundle source list|sync --source DIR --trust KEY [--loose]\n';

/** `bundle source` 用法提示（G2 私有技能源）。 */
/** `bundle grade` 用法提示（H1 分级）。 */
const GRADE_USAGE =
  '用法: omniharness bundle grade <path.ohb> [--declare process,fs-write] [--sandbox-level LEVEL]\n' +
  '说明: 产出 A/B/C 评级（评级即门禁输出）；C ⇒ 退出码 1（不可安装）。\n';

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
    if (sub === 'grade') {
      return this.grade(reader);
    }
    process.stdout.write(USAGE);
    return 2;
  }

  /**
   * `bundle grade <path.ohb> [--declare a,b] [--sandbox-level L]`：**H1 市场分级**（A/B/C）。
   *
   * 三条腿都在这里真跑：① 静态扫描读包内文件文本；② 沙箱腿用 `IsolationLadder` 在受限环境里
   * 执行包声明的入口（`index.js`）；③ 差异测试比对"声明权限 ⊖ 扫描到的实际能力"。
   * **评级即门禁输出**：`C` ⇒ 退出码 1（市场/安装器据此拒绝），不是打印个字母就完事。
   * @param reader 参数读取器（位置参数 1 为 `.ohb` 路径）
   * @returns 退出码（0 = A/B 可安装；1 = C / 读不出包；2 = 用法错误）
   */
  private async grade(reader: CliArgReader): Promise<number> {
    const path = reader.at(1);
    if (path === undefined) {
      process.stdout.write(GRADE_USAGE);
      return 2;
    }
    const read = BundleCodec.readFiles(path);
    if (!read.ok) {
      process.stderr.write(`无法读取包：${read.reason}\n`);
      return 1;
    }
    const declared = (reader.value('--declare') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '') as readonly PackCapability[];
    const sandbox = await this.sandboxLeg(path, read.files, reader.value('--sandbox-level'));
    const report = PackGrader.grade({ files: read.files, declared, sandbox });
    process.stdout.write(
      `评级 ${report.rating}（${report.installable ? '可安装' : '不可安装'}）｜ ${path}\n`,
    );
    for (const reason of report.reasons) process.stdout.write(`  · ${reason}\n`);
    process.stdout.write(
      `  证据：扫过 ${String(report.evidence.scan.scannedFiles)} 文件 / 发现 ${String(report.evidence.scan.findings.length)} 条` +
        `｜实际能力 [${report.evidence.scan.capabilities.join(', ')}]` +
        `｜未声明 [${report.evidence.diff.undeclared.join(', ')}]\n`,
    );
    return report.installable ? 0 : 1;
  }

  /**
   * 沙箱腿：把包声明的入口（`index.js`）交给 `IsolationLadder` 在受限环境里执行。
   *
   * 为什么"跑通"要算证据：静态扫描只能看**有没有用到**危险 API；跑不起来说明这个包在受限环境里
   * 根本不成立（粗糙/恶意包常在这里暴露）。执行失败**不抛**——它是证据，不是异常。
   * @param path 包路径
   * @param files 包内文件表
   * @param level 指定隔离层级（缺省交给阶梯自选）
   * @returns 沙箱腿结论
   */
  private async sandboxLeg(
    path: string,
    files: ReadonlyMap<string, string>,
    level: string | undefined,
  ): Promise<SandboxLegVerdict> {
    // 入口定位：真实 bundle 把插件放在 `plugins/<name>/index.js`，故按"路径最短优先、同长按字典序"
    // 从全部 index.js 里确定性挑一个（报出用的是哪个，否则"跑通了哪个文件"无从复核）。
    const entryPath = [...files.keys()]
      .filter((name) => /(^|\/)index\.(js|mjs|cjs)$/i.test(name))
      .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))[0];
    if (entryPath === undefined) {
      return { ran: false, reason: '包内无 index.js 入口，无法在沙箱中执行（H1 要求可运行验证）' };
    }
    const entry = files.get(entryPath) ?? '';
    const ladder = IsolationLadderFactory.builtin();
    // 脚本包装：沙箱按**裸脚本**语义执行，不提供 `module`/`exports`，故这里自己包一层 IIFE，
    // 让常见的 cjs 入口（`module.exports = …`）**真的**能跑起来——否则"沙箱腿"对一切包恒为失败，
    // 那条腿就等于没有（评级退化成只靠静态扫描，A 永远不可达）。
    // **不提供 `require`**：这正是沙箱该有的样子（包内不得起进程/引原生模块），
    // 于是"越权包"会在这里以 `require is not defined` 暴露，而不是被静默放行。
    const wrapped = `(function (module, exports) {\n${entry}\nreturn module.exports;\n})({ exports: {} }, {})`;
    // 档位策略（**不 overclaim**）：资产按仓库默认档 `in-process` 声明，然后**先试更严的档**
    // （缺省 `vm`），更严档不可达时如实回落到 `in-process`——报告里的 `level` 是**实际生效**档位。
    // 不做"请求 os-sandbox 然后静默降档"：那会让报告声称跑在更强隔离里（阶梯本身也拒这种放松）。
    const candidates = level !== undefined ? [level, 'in-process'] : ['vm', 'in-process'];
    let lastReason = '未尝试任何档位';
    for (const candidate of candidates) {
      try {
        const result = await ladder.run({
          asset: {
            kind: 'plugin',
            name: path,
            version: '1',
            governance: { isolation: 'in-process' },
          } as never,
          payload: { kind: 'js-source', code: wrapped, filename: entryPath },
          level: candidate as never,
          timeoutMs: 5_000,
        });
        if (result.ok) return { ran: true, level: String(result.level), entry: entryPath };
        // 失败形状是 `{ ok:false, denied:{ code, reason } }`：透出**分类 + 原因**，
        // 不压成一句"沙箱失败"——市场页要显示"为什么"（timeout / trap / escape 区别很大）。
        lastReason = `[${result.denied.code}] ${result.denied.reason}`;
        // 最小权限模式的**预期**结果：包声明并实际使用宿主能力（`require`）时，沙箱必然拒绝
        // ——`escape` 分类 + `require is not defined`。这不是包的缺陷，也不是"验证通过"，
        // 而是**验证能力边界**：交给分级器封顶 B（受限运行），绝不因此放行到 A。
        if (
          result.denied.code === 'escape' &&
          /require is not defined/.test(result.denied.reason)
        ) {
          return {
            ran: false,
            level: candidate,
            entry: entryPath,
            minimalAuthority: true,
            reason: `沙箱以最小权限运行（不提供 require），该包的实际能力无法动态覆盖：${result.denied.reason}`,
          };
        }
        // 仅"档位不可达"才回落；`trap`/`escape`/`timeout` 是**包的问题**，继续换档没有意义。
        if (result.denied.code !== 'level-unavailable') {
          return { ran: false, level: candidate, entry: entryPath, reason: lastReason };
        }
      } catch (err) {
        lastReason = `沙箱执行异常：${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return { ran: false, entry: entryPath, reason: lastReason };
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
