import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `omni-cli` 原生二进制定位器。
 *
 * 原生 Windows 写隔离需要 Rust CLI 作为启动器；它不在 npm 依赖里，而是本仓 `target/`
 * 下的构建产物（或用户显式安装到 PATH 的同名程序）。本定位器只做**文件存在性**判断，
 * 不 spawn 进程；找不到时给出可执行的构建/安装提示（fail-closed，绝不静默退回策略档）。
 */
export class OmniCliLocator {
  /** 环境变量覆盖（测试/自定义安装路径）。 */
  private static readonly ENV_KEY = 'OMNI_CLI_BIN';
  /** 可执行文件名（Windows 带扩展名）。 */
  private static readonly BINARY_NAME = process.platform === 'win32' ? 'omni-cli.exe' : 'omni-cli';

  /**
   * 尝试定位；找不到返回 undefined。
   * @returns 二进制绝对路径或 undefined。
   */
  public static tryLocate(): string | undefined {
    const explicit = process.env[OmniCliLocator.ENV_KEY];
    if (explicit !== undefined && explicit !== '' && existsSync(explicit)) {
      return explicit;
    }
    const root = OmniCliLocator.repoRoot();
    for (const candidate of [
      join(root, 'target', 'release', OmniCliLocator.BINARY_NAME),
      join(root, 'target', 'debug', OmniCliLocator.BINARY_NAME),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    const path = process.env['PATH'] ?? '';
    for (const dir of path.split(delimiter)) {
      if (dir === '') continue;
      const candidate = join(dir, OmniCliLocator.BINARY_NAME);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  /**
   * 定位；找不到即抛错。
   * @returns 二进制绝对路径。
   * @throws 找不到时给出可执行的构建/安装提示。
   */
  public static locate(): string {
    const found = OmniCliLocator.tryLocate();
    if (found !== undefined) return found;
    throw new Error(
      'windows-native 需要 omni-cli 二进制（原生写隔离启动器）：' +
        '请在仓库根运行 `cargo build -p omni-cli`（或 `npm run native:build`），' +
        '或用 OMNI_CLI_BIN 指向已安装的 omni-cli',
    );
  }

  /**
   * 由当前文件位置向上找到仓根（源码 `src/native` 与产物 `dist/src/native` 都适用）。
   * @returns 仓根绝对路径；找不到 package.json 时退回上两级。
   */
  private static repoRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i += 1) {
      if (existsSync(join(dir, 'package.json'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  }
}
