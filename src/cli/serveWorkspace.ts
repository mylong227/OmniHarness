/**
 * serve 的工作区解析：**显式 --workspace > 本机固定项目 > 启动目录**（2026-10-06 用户口径）。
 *
 * 为什么单独成文件（而不是留在 `CliServerCmds` 里）：
 * ① 它是一组**纯决策**（读旗标、读用户级配置、判来源），与"起 HTTP 服务"无关，本就不该混在命令类里；
 * ② 实测教训——把它们塞进 `CliServerCmds` 直接把该文件顶过「上帝类」代码行阈值（增量门禁当场拦下）；
 * ③ 独立后可在**不绑端口、不起服务**的前提下被单测穷举（见 `tests/unit/serveRootResolution.test.ts`）。
 *
 * 判定链与"为什么不与第六十轮矛盾"见 {@link ServeWorkspace.serveRootOf} 的注释。
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configFile } from '../config/configFile.js';
import { ArgParser } from './argParser.js';
import { CliArgReader } from './cliArgReader.js';
import { PortablePath } from '../util/portablePath.js';

/**
 * serve 的工作区解析器（无状态，纯静态）：显式旗标 > 本机固定项目 > 启动目录。
 */
export class ServeWorkspace {
  /**
   * 取用户**显式**给出的 `--workspace`（没给返回 undefined）。
   *
   * 为什么不能拿"解析结果"判断显式与否（2026-10-06 实测踩到的坑）：`CliDefaults.workspace` 的默认值
   * 就是 `process.cwd()`，所以 `ArgParser.parseArgs(...).workspace` **恒为字符串**——用它当"用户给了吗"
   * 的判据，永远走"显式"分支，本机固定项目就永远读不到（现场表现为：从任意目录启动都停在启动目录，
   * 还把这个目录**覆盖**登记成了本机固定项目）。判据看旗标是否出现。
   * @param args 子命令参数（`serveArgs`）。
   * @returns 显式工作区路径；未给出为 undefined。
   */
  public static explicitWorkspaceOf(args: readonly string[]): string | undefined {
    const spaced = new CliArgReader(args).value('--workspace');
    if (spaced !== undefined && spaced !== '' && !spaced.startsWith('--')) return spaced;
    // `--workspace=<dir>` 形态必须一并认（`CliArgReader.value` 只认空格分隔形态——第六十轮修过解析器，
    // 但那是 `ArgParser` 的能力，本判定不走解析器，故在这里自己认两种形态，避免"写了等于没写"）。
    const inline = args.find((arg) => arg.startsWith('--workspace='));
    const value = inline?.slice('--workspace='.length) ?? '';
    return value === '' ? undefined : value;
  }

  /**
   * 解析 `serve` 的工作区根：**显式 `--workspace` > 本机固定项目 > 启动目录**。
   *
   * 为什么是这三档（2026-10-06 用户口径："项目固定、可配置，无论从哪启动都读得到；私密配置只落本地"）：
   * ① 显式旗标永远最高优先（脚本/CI 可复现）；
   * ② 否则用**用户级配置**里记的当前项目（`~/.omniharness/omniharness.json` 的 `workspace`）——
   *    它由 UI 的项目切换写入本机，因此"上次在用哪个项目"跨目录、跨重启都成立；路径不存在则跳过
   *    （绝不指向已删除的目录）；
   * ③ 最后回落到启动目录（老行为：`cd 项目 && omniharness serve` 依旧）
   *
   * 注意：第 ② 档是**刻意复活**的行为。2026-09（第六十轮）曾把"持久化 workspace 参与根解析"判为缺陷
   * 并改为只认启动目录——那条裁决针对的是**单跑 `-p` 路径静默跑偏**（无提示、用户无法预知）。
   * 本轮的区别是：读的是**本机（用户级）**配置、且启动横幅**显式打印来源**、`--workspace` 可随时覆盖。
   *
   * @param requested 显式 `--workspace`（未给为 undefined）。
   * @param cwd 启动目录（proces.cwd()）。
   * @param userHomedir 用户级配置家目录覆盖（缺省 `os.homedir()`；测试注入用）。
   * @returns 生效根与其**来源**（`flag` / `local` / `local-missing` / `cwd`）。**分隔符恒为 `/`**
   *   （`PortablePath` 口径，便于跨平台比较）；`runServe` 再用 `ArgParser.toWindowsPath` 转回本机形态。
   */
  public static serveRootOf(
    requested: string | undefined,
    cwd: string,
    userHomedir?: string,
  ): { root: string; source: 'flag' | 'local' | 'local-missing' | 'cwd' } {
    if (requested !== undefined && requested !== '') {
      return { root: requested, source: 'flag' };
    }
    const home = userHomedir ?? homedir();
    const localPath = join(home, '.omniharness', configFile.FILE_NAME);
    let local: string | undefined;
    try {
      const configured = configFile.load(localPath).workspace;
      // 可移植写法（`~/…` / `$VAR` / `%VAR%` / 相对家目录）在此展开成**本机**真实路径：
      // 同一份配置换机器、换用户名、换盘符都还能落到正确目录（见 PortablePath）。
      if (typeof configured === 'string' && configured !== '') {
        local = PortablePath.expand(configured, home);
      }
    } catch {
      // 用户级配置损坏：不因它阻断启动（分层加载稍后会 fail-closed 报可读错误）。
      local = undefined;
    }
    if (local === undefined) return { root: cwd, source: 'cwd' };
    if (!existsSync(local) || !statSync(local).isDirectory()) {
      return { root: cwd, source: 'local-missing' };
    }
    return { root: local, source: 'local' };
  }

  /**
   * 把工作区来源翻成人话（启动横幅用）。
   * @param source serveRootOf 返回的来源标识。
   * @returns 一行中文说明。
   */
  public static describeRootSource(source: 'flag' | 'local' | 'local-missing' | 'cwd'): string {
    switch (source) {
      case 'flag':
        return '来自 --workspace';
      case 'local':
        return '来自本机固定项目（~/.omniharness/omniharness.json 的 workspace；用 --workspace 可覆盖）';
      case 'local-missing':
        return '本机固定项目的路径已不存在 ⇒ 回落启动目录（请用 --workspace 指定，或在 UI 里切换项目）';
      default:
        return '来自启动目录';
    }
  }

  /**
   * 解析工作区 + **说出来源** + 按需登记本机固定项目；`runServe` 只调它一行（函数体基线所迫）。
   *
   * 三件事必须在一起做，否则就会出现"静默改语义"：① 判定来源（`--workspace` > 本机固定项目 >
   * 启动目录）；② 在横幅里打印**是哪一个来源**（2026-10-06 用户口径：无论从哪启动都要能正确读到
   * 项目，且要看得见为什么）；③ 只有**显式 `--workspace`** 才登记本机固定项目——那是一次明确的
   * "就用这个项目"配置动作。绝不因"启动目录"写盘：实测教训是集成测试/CI 在临时工作区起 serve 时，
   * 自动登记会把临时目录写进用户**真实**的本机配置（测试污染用户环境）。
   * @param serveArgs 子命令参数（读取显式 `--workspace`）。
   * @param cwd 启动目录。
   * @param userHomedir 用户级配置家目录覆盖（测试注入用）。
   * @returns 生效的工作区根（Windows 分隔形态）。
   */
  public static announceServeWorkspace(
    serveArgs: readonly string[],
    cwd: string,
    userHomedir?: string,
  ): string {
    const picked = ServeWorkspace.serveRootOf(
      ServeWorkspace.explicitWorkspaceOf(serveArgs),
      cwd,
      userHomedir,
    );
    const wsRoot = ArgParser.toWindowsPath(picked.root);
    process.stdout.write(
      `工作区: ${wsRoot}（${ServeWorkspace.describeRootSource(picked.source)}）\n`,
    );
    return wsRoot;
  }
}
