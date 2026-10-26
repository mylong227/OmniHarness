/** 运行路径解析（开发态 = 仓库根；打包态 = resources/harness）。 */
import { app } from 'electron';
import { join, resolve } from 'node:path';

/**
 * Harness 根目录。
 * @returns 开发态为仓库根，打包态为 `resources/harness`。
 */
export function harnessRoot(): string {
  return app.isPackaged
    ? resolve(process.resourcesPath, 'harness')
    : resolve(app.getAppPath(), '..');
}

/**
 * Harness CLI 入口。
 * @returns `dist/src/cli/exec.js` 的绝对路径。
 */
export function harnessEntry(): string {
  return join(harnessRoot(), 'dist', 'src', 'cli', 'exec.js');
}

/**
 * Node 解释器。
 * 开发态优先 `OMNI_NODE_BIN`，否则使用 PATH 里的 `node`；打包态固定 `resources/harness/node.exe`。
 * @returns 可执行文件路径/命令。
 */
export function nodeBinary(): string {
  if (app.isPackaged) {
    return join(
      process.resourcesPath,
      'harness',
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
  }
  const configured = (process.env['OMNI_NODE_BIN'] ?? '').trim();
  return configured !== '' ? configured : 'node';
}

/**
 * 桌面日志目录（用户级）。
 * @param userDataDir Electron userData。
 * @param dirName 目录名（桌面配置）。
 * @returns 绝对路径。
 */
export function logDir(userDataDir: string, dirName: string): string {
  return join(userDataDir, dirName);
}

/**
 * 桌面临时运行目录（就绪文件等）。
 * @param userDataDir Electron userData。
 * @param dirName 目录名（桌面配置）。
 * @returns 绝对路径。
 */
export function runDir(userDataDir: string, dirName: string): string {
  return join(userDataDir, dirName);
}

/**
 * 模型缓存目录（必须可写，不能落在 Program Files）。
 * @param userDataDir Electron userData。
 * @param dirName 目录名（桌面配置）。
 * @returns 绝对路径。
 */
export function modelDir(userDataDir: string, dirName: string): string {
  return join(userDataDir, dirName);
}

/**
 * 向量缓存目录。
 * @param userDataDir Electron userData。
 * @param dirName 目录名（桌面配置）。
 * @returns 绝对路径。
 */
export function vectorDir(userDataDir: string, dirName: string): string {
  return join(userDataDir, dirName);
}
