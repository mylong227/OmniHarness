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
 * @returns 绝对路径。
 */
export function logDir(): string {
  return join(app.getPath('userData'), 'logs');
}

/**
 * 桌面运行目录（就绪文件等）。
 * @returns 绝对路径。
 */
export function runDir(): string {
  return join(app.getPath('userData'), 'run');
}

/**
 * 模型/向量缓存目录（必须可写，不能落在 Program Files）。
 * @returns 绝对路径。
 */
export function modelDir(): string {
  return join(app.getPath('userData'), 'models');
}

/**
 * 向量缓存目录。
 * @returns 绝对路径。
 */
export function vectorDir(): string {
  return join(app.getPath('userData'), 'vec-cache');
}
